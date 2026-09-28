"""
Servidor local. Es lo unico que habla con la red, y solo en la wifi de casa.

Endpoints:
    GET  /health                    estado de OCR y LLM
    POST /models                    crea un modelo vacio
    GET  /models                    lista los modelos
    GET  /models/{id}               modelo + preguntas pendientes
    POST /models/{id}/scan          foto -> OCR -> LLM -> merge -> preguntas
    POST /models/{id}/answers       respuesta a preguntas
    GET  /models/{id}/questions     preguntas pendientes
    GET  /models/{id}/export.pdm    descarga el .pdm

El modelo se mantiene en memoria indexado por id, y se persiste en SQLite en
cada cambio. Es de un solo usuario, asi que no hay sesiones ni autenticacion;
aun asi, el servidor solo escucha en la red local y avisa de ello al arrancar.
"""

from __future__ import annotations

import io
import logging
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from . import llm as llm_modulo
from . import ocr as ocr_modulo
from .llm import LlmNoDisponible, OllamaClient
from .merge import apply_answers, merge
from .ocr import OcrNotAvailable
from .pdm.generator import PdmGenerationError, build_pdm
from .questions import blocking_questions, completion, questions_for
from .schema import Answer, DataModel, Question, ScanResult
from .store import Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pdm-scanner")

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
IMAGES_DIR = DATA_DIR / "images"
UPLOADS_DIR = DATA_DIR / "uploads"

for directorio in (DATA_DIR, IMAGES_DIR, UPLOADS_DIR):
    directorio.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="PDM Scanner",
    version="0.1.0",
    description="Convierte fotos de un diagrama de modelo de datos en un .pdm de PowerDesigner. Todo local.",
)

# El servidor corre en el PC y la app en el movil: hace falta permitir el
# acceso desde otro origen. Se limita a la red local, no a "*".
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)",
    allow_methods=["*"],
    allow_headers=["*"],
)

store = Store(DATA_DIR / "pdm_scanner.db")
llm = OllamaClient()

# Cache en memoria: un solo usuario, un modelo a la vez.
_modelos: dict[int, DataModel] = {}
_ultimo_id: int | None = None


def _cargar_o_crear(model_id: int | None) -> tuple[int, DataModel]:
    global _ultimo_id

    if model_id is not None:
        modelo = store.get_model(model_id)
        if modelo is None:
            raise HTTPException(404, f"no existe el modelo {model_id}")
        _modelos[model_id] = modelo
        _ultimo_id = model_id
        return model_id, modelo

    if _ultimo_id is not None and _ultimo_id in _modelos:
        return _ultimo_id, _modelos[_ultimo_id]

    creado = store.latest_model()
    if creado is not None:
        _modelos[creado[0]] = creado[1]
        _ultimo_id = creado[0]
        return creado

    nuevo = store.create_model("Modelo escaneado")
    guardados = store.list_models()
    model_id = guardados[0]["id"] if guardados else 1
    store.save_model(model_id, nuevo)
    _modelos[model_id] = nuevo
    _ultimo_id = model_id
    return model_id, nuevo


def _guardar(model_id: int, modelo: DataModel) -> None:
    modelo.updated_at = datetime.now(timezone.utc)
    _modelos[model_id] = modelo
    store.save_model(model_id, modelo)


# --------------------------------------------------------------------------
# Estado
# --------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    """Que hay instalado. La app lo muestra al arrancar para no fallar a ciegas."""
    motores = ocr_modulo.available_engines()
    estado_llm = llm.status()
    return {
        "servidor": "ok",
        "ocr": {
            "disponible": bool(motores),
            "motores": motores,
            "detalle": (
                ""
                if motores
                else "instala paddleocr o tesseract: pip install paddleocr / winget install UB-Mannheim.TesseractOCR"
            ),
        },
        "llm": {
            "disponible": estado_llm.disponible,
            "modelo": estado_llm.modelo,
            "modelos_instalados": estado_llm.modelos_instalados,
            "recomendados": llm_modulo.MODELOS_RECOMENDADOS,
            "detalle": estado_llm.detalle,
        },
    }


# --------------------------------------------------------------------------
# Modelos
# --------------------------------------------------------------------------


@app.post("/models")
def crear_modelo(nombre: str = Body(default="Modelo escaneado", embed=True)) -> dict:
    global _ultimo_id

    modelo = store.create_model(nombre)
    guardados = store.list_models()
    model_id = guardados[0]["id"] if guardados else 1
    store.save_model(model_id, modelo)
    _modelos[model_id] = modelo
    _ultimo_id = model_id
    return {"id": model_id, "model": modelo.model_dump(mode="json")}


@app.get("/models")
def listar_modelos() -> dict:
    return {"models": store.list_models()}


@app.get("/models/{model_id}")
def obtener_modelo(model_id: int) -> dict:
    _, modelo = _cargar_o_crear(model_id)
    return _resumen(modelo)


def _resumen(modelo: DataModel) -> dict:
    preguntas = questions_for(modelo)
    return {
        "model": modelo.model_dump(mode="json"),
        "stats": modelo.stats(),
        "completion": completion(modelo),
        "questions": [p.model_dump(mode="json") for p in preguntas],
        "blocking_questions": len(blocking_questions(modelo)),
    }


@app.delete("/models/{model_id}")
def borrar_modelo(model_id: int) -> dict:
    store.delete_model(model_id)
    _modelos.pop(model_id, None)
    return {"ok": True}


# --------------------------------------------------------------------------
# Escaneo
# --------------------------------------------------------------------------


@app.post("/models/{model_id}/scan")
async def escanear(
    model_id: int,
    foto: UploadFile = File(...),
    motor_ocr: str = Form(default="auto"),
    aplicar_automatico: bool = Form(default=True),
) -> dict:
    """Foto -> OCR -> LLM -> merge -> preguntas.

    Devuelve el modelo ya fusionado y la lista de preguntas. No escribe nada
    en el modelo final hasta que el usuario responda: lo detectado entra como
    `inferred`.
    """
    _, base = _cargar_o_crear(model_id)
    inicio = time.time()

    contenido = await foto.read()
    if not contenido:
        raise HTTPException(400, "la foto está vacía")
    if len(contenido) > 25 * 1024 * 1024:
        raise HTTPException(413, "la foto pesa más de 25 MB")

    nombre = foto.filename or "foto.jpg"
    destino = IMAGES_DIR / f"{uuid.uuid4().hex}_{Path(nombre).name}"
    destino.write_bytes(contenido)

    # 1. OCR
    try:
        procesada = ocr_modulo.preprocess(contenido)
        resultado_ocr = ocr_modulo.run_ocr(procesada, engine=motor_ocr)
    except OcrNotAvailable as error:
        raise HTTPException(503, str(error)) from error
    except Exception as error:  # noqa: BLE001
        log.exception("Fallo el OCR")
        raise HTTPException(500, f"el OCR falló: {error}") from error

    if not resultado_ocr.boxes:
        resultado = ScanResult(
            model=base,
            questions=questions_for(base),
            raw_ocr="",
            elapsed_seconds=time.time() - inicio,
            warnings=[
                "No se ha leído ningún texto de la foto. Prueba con más luz, más cerca "
                "y sin reflejos."
            ],
        )
        scan_id = store.save_scan(model_id, resultado, str(destino), resultado_ocr.engine)
        return _resumen(base) | {
            "scan_id": scan_id,
            "ocr_engine": resultado_ocr.engine,
            "ocr_boxes": 0,
            "warnings": resultado.warnings,
            "elapsed_seconds": round(resultado.elapsed_seconds, 2),
        }

    log.info(
        "OCR (%s): %d fragmentos en %.1fs", resultado_ocr.engine, len(resultado_ocr.boxes), time.time() - inicio
    )

    # 2. LLM
    avisos: list[str] = []
    if not aplicar_automatico:
        avisos.append("No se ha llamado al LLM (aplicar_automatico=false).")
        envelope = None
    else:
        try:
            envelope = llm.extract(resultado_ocr.as_prompt())
            avisos.extend(envelope.notes)
        except LlmNoDisponible as error:
            raise HTTPException(503, str(error)) from error

    # 3. Merge
    if envelope is not None:
        entrante = DataModel(
            name=base.name,
            dbms=base.dbms,
            tables=envelope.tables,
            foreign_keys=envelope.foreign_keys,
            sources=[str(destino)],
        )
        fusionado, informe = merge(base, entrante)
        if informe.has_conflicts:
            avisos.append(
                f"{len(informe.conflicts)} conflicto(s) con lo ya confirmado. "
                "Se ha mantenido lo que habías confirmado."
            )
        avisos.extend(informe.ignored)
    else:
        fusionado = base

    resultado = ScanResult(
        model=fusionado,
        questions=questions_for(fusionado),
        raw_ocr=resultado_ocr.text,
        elapsed_seconds=time.time() - inicio,
        warnings=avisos,
    )
    scan_id = store.save_scan(model_id, resultado, str(destino), resultado_ocr.engine)
    _guardar(model_id, fusionado)

    return _resumen(fusionado) | {
        "scan_id": scan_id,
        "ocr_engine": resultado_ocr.engine,
        "ocr_boxes": len(resultado_ocr.boxes),
        "warnings": avisos,
        "elapsed_seconds": round(resultado.elapsed_seconds, 2),
    }


# --------------------------------------------------------------------------
# Preguntas
# --------------------------------------------------------------------------


@app.get("/models/{model_id}/questions")
def preguntas(model_id: int) -> dict:
    _, modelo = _cargar_o_crear(model_id)
    lista = questions_for(modelo)
    return {
        "questions": [p.model_dump(mode="json") for p in lista],
        "blocking": [p.model_dump(mode="json") for p in blocking_questions(modelo)],
        "completion": completion(modelo),
    }


@app.post("/models/{model_id}/answers")
def responder(model_id: int, respuestas: list[Answer] = Body(...)) -> dict:
    """Aplica las respuestas y marca lo confirmado como intocable."""
    _, modelo = _cargar_o_crear(model_id)
    actualizado = apply_answers(modelo, respuestas)
    _guardar(model_id, actualizado)
    return _resumen(actualizado)


# --------------------------------------------------------------------------
# Exportación
# --------------------------------------------------------------------------


@app.get("/models/{model_id}/export.pdm")
def exportar_pdm(model_id: int) -> Response:
    _, modelo = _cargar_o_crear(model_id)
    try:
        xml, avisos = build_pdm(modelo)
    except PdmGenerationError as error:
        raise HTTPException(500, str(error)) from error

    nombre = f"{modelo.name or 'modelo'}.pdm".replace(" ", "_")
    log.info("Generado %s (%d avisos)", nombre, len(avisos))
    cabeceras = {
        "X-PDM-Warnings": "; ".join(avisos)[:900],
    }
    return Response(
        content=xml.encode("utf-8"),
        media_type="application/xml",
        headers={
            "Content-Disposition": f'attachment; filename="{nombre}"',
            **cabeceras,
        },
    )


@app.get("/models/{model_id}/export.sql")
def exportar_sql(model_id: int) -> Response:
    """DDL Oracle del modelo, para tener una vista rapida sin abrir PowerDesigner."""
    _, modelo = _cargar_o_crear(model_id)
    lineas: list[str] = []

    for tabla in modelo.tables:
        partes: list[str] = []
        for columna in tabla.columns:
            trozo = f'  "{columna.name}" {columna.display_type}'
            if columna.mandatory:
                trozo += " NOT NULL"
            partes.append(trozo)

        pk = tabla.primary_key
        if pk is not None:
            nombres = [tabla.column(c).name for c in pk.columns if tabla.column(c)]
            lista = ", ".join(f'"{nombre}"' for nombre in nombres)
            partes.append(f'  CONSTRAINT "{pk.name}" PRIMARY KEY ({lista})')

        lineas.append(f'CREATE TABLE "{tabla.name}" (\n' + ",\n".join(partes) + "\n);")

    for fk in modelo.foreign_keys:
        padre = modelo.table(fk.parent_table)
        hija = modelo.table(fk.child_table)
        if padre is None or hija is None:
            continue
        columnas_padre = [padre.column(c).name for c in fk.parent_columns if padre.column(c)]
        columnas_hija = [hija.column(c).name for c in fk.child_columns if hija.column(c)]
        if not columnas_padre or len(columnas_padre) != len(columnas_hija):
            continue
        lista_padre = ", ".join(f'"{n}"' for n in columnas_padre)
        lista_hija = ", ".join(f'"{n}"' for n in columnas_hija)
        lineas.append(
            f'ALTER TABLE "{hija.name}" ADD CONSTRAINT "{fk.name}" '
            f"FOREIGN KEY ({lista_hija}) REFERENCES \"{padre.name}\" ({lista_padre});"
        )

    return Response(
        content="\n\n".join(lineas).encode("utf-8"),
        media_type="text/plain",
        headers={"Content-Disposition": 'attachment; filename="modelo.sql"'},
    )


@app.get("/")
def raiz() -> dict:
    return {
        "servidor": "PDM Scanner",
        "docs": "/docs",
        "estado": "/health",
    }
