"""
Pruebas de la API con OCR y LLM simulados.

No se llama a Ollama ni a PaddleOCR: se sustituyen por dobles que devuelven
una foto "leida". Asi el test es rapido, no necesita GPU y comprueba lo que
importa, que es el contrato HTTP y el orden de los pasos.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.ocr import OcrResult, TextBox


@pytest.fixture()
def cliente(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Cliente con la base de datos en un temporal y OCR/LLM simulados."""
    import app.main as main

    # Se recarga el modulo para que coja el DATA_DIR del temporal.
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "IMAGES_DIR", tmp_path / "images")
    monkeypatch.setattr(main, "UPLOADS_DIR", tmp_path / "uploads")
    (tmp_path / "images").mkdir(parents=True, exist_ok=True)
    main.store = main.Store(tmp_path / "test.db")
    main._modelos.clear()
    main._ultimo_id = None
    return TestClient(main.app)


# -- Dobles ----------------------------------------------------------------

BOCES = [
    TextBox(text="CLIENTE", confidence=0.95, box=(100, 50, 300, 80)),
    TextBox(text="CLI_ID", confidence=0.93, box=(110, 90, 220, 110)),
    TextBox(text="NUMBER(8)", confidence=0.9, box=(240, 90, 380, 110)),
    TextBox(text="CLI_NIF", confidence=0.92, box=(110, 115, 220, 135)),
    TextBox(text="VARCHAR2(9)", confidence=0.91, box=(240, 115, 380, 135)),
]

RESPUESTA_LLM = """\
```json
{
  "tables": [
    {
      "code": "CLIENTE",
      "name": "Cliente",
      "columns": [
        {"code": "CLI_ID", "name": "CLI_ID", "data_type": "NUMBER", "length": 8,
         "mandatory": true, "identity": true, "confidence": "inferred"},
        {"code": "CLI_NIF", "name": "CLI_NIF", "data_type": "VARCHAR2", "length": 9,
         "mandatory": true, "confidence": "inferred"}
      ],
      "keys": [
        {"name": "PK_CLIENTE", "columns": ["CLI_ID"], "is_primary": true, "confidence": "pending"}
      ],
      "indexes": []
    }
  ],
  "foreign_keys": [],
  "notes": ["La longitud de CLI_NIF no se ve muy bien"]
}
```"""


@pytest.fixture()
def con_ocr_y_llm_falsos(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.llm as llm_modulo
    import app.main as main
    import app.ocr as ocr_modulo

    monkeypatch.setattr(ocr_modulo, "preprocess", lambda datos: datos)
    monkeypatch.setattr(
        ocr_modulo,
        "run_ocr",
        lambda datos, engine="auto", psm="AUTO": OcrResult(boxes=BOCES, engine="falso", width=800, height=600),
    )
    monkeypatch.setattr(ocr_modulo, "available_engines", lambda: ["falso"])

    def extract_falso(prompt: str):
        from app.llm import _build_envelope, _parse_json

        envelope = _build_envelope(_parse_json(RESPUESTA_LLM))
        envelope.notes.append("nota del LLM simulado")
        return envelope

    monkeypatch.setattr(main.llm, "extract", extract_falso)
    monkeypatch.setattr(main.llm, "status", lambda: llm_modulo.LlmStatus(True, "falso", "", ["falso"]))


# -- Tests -----------------------------------------------------------------


def test_health_informa_de_lo_que_falta(cliente: TestClient) -> None:
    respuesta = cliente.get("/health")
    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    # Aunque no haya nada instalado, /health tiene que responder 200 y explicar
    # qué instalar: es lo primero que mira la app.
    assert "ocr" in cuerpo and "llm" in cuerpo
    assert "detalle" in cuerpo["ocr"]


def test_crear_y_leer_un_modelo(cliente: TestClient) -> None:
    creado = cliente.post("/models", json={"nombre": "Banco"}).json()
    assert creado["id"] >= 1

    leido = cliente.get(f"/models/{creado['id']}").json()
    assert leido["model"]["name"] == "Banco"
    assert leido["stats"]["tablas"] == 0
    assert leido["completion"] == 0.0


def test_escaneo_extrae_tabla_y_pregunta_la_pk(cliente: TestClient, con_ocr_y_llm_falsos) -> None:
    model_id = cliente.post("/models", json={"nombre": "Banco"}).json()["id"]

    respuesta = cliente.post(
        f"/models/{model_id}/scan",
        files={"foto": ("diagrama.jpg", b"falso-jpeg", "image/jpeg")},
        data={"motor_ocr": "auto", "aplicar_automatico": "true"},
    )
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()

    assert cuerpo["stats"]["tablas"] == 1
    tabla = cuerpo["model"]["tables"][0]
    assert tabla["code"] == "CLIENTE"
    assert [c["code"] for c in tabla["columns"]] == ["CLI_ID", "CLI_NIF"]

    # La PK llega deducida, asi que tiene que haber pregunta.
    preguntas = [q for q in cuerpo["questions"] if q["kind"] == "primary_key"]
    assert preguntas, "una PK deducida por convención debe preguntarse"
    assert cuerpo["blocking_questions"] >= 1

    # Las notas del LLM se devuelven, no se pierden.
    assert any("nota del LLM simulado" in w for w in cuerpo["warnings"])


def test_responder_confirma_la_pk_y_sube_la_completitud(
    cliente: TestClient, con_ocr_y_llm_falsos
) -> None:
    model_id = cliente.post("/models", json={"nombre": "Banco"}).json()["id"]
    escaneo = cliente.post(
        f"/models/{model_id}/scan",
        files={"foto": ("d.jpg", b"falso", "image/jpeg")},
    ).json()

    antes = escaneo["completion"]
    pk = next(q for q in escaneo["questions"] if q["kind"] == "primary_key")

    respuesta = cliente.post(
        f"/models/{model_id}/answers",
        json=[{"question_id": pk["id"], "value": "CLI_ID", "apply": "key", "target": "CLIENTE"}],
    )
    assert respuesta.status_code == 200
    cuerpo = respuesta.json()

    assert cuerpo["completion"] > antes
    assert cuerpo["model"]["tables"][0]["keys"][0]["confidence"] == "confirmed"
    # Confirmada la PK, ya no se pregunta por ella.
    assert not [q for q in cuerpo["questions"] if q["kind"] == "primary_key"]


def test_exportar_pdm_devuelve_xml_descargable(cliente: TestClient, con_ocr_y_llm_falsos) -> None:
    model_id = cliente.post("/models", json={"nombre": "Banco"}).json()["id"]
    cliente.post(f"/models/{model_id}/scan", files={"foto": ("d.jpg", b"falso", "image/jpeg")})

    respuesta = cliente.get(f"/models/{model_id}/export.pdm")
    assert respuesta.status_code == 200
    assert "attachment" in respuesta.headers["content-disposition"]

    texto = respuesta.content.decode("utf-8")
    assert texto.startswith("<?xml")
    assert "<?PowerDesigner" in texto
    assert "<a:Code>CLIENTE</a:Code>" in texto
    assert "<a:DataType>NUMBER</a:DataType>" in texto


def test_exportar_sql_da_el_ddl_oracle(cliente: TestClient, con_ocr_y_llm_falsos) -> None:
    model_id = cliente.post("/models", json={"nombre": "Banco"}).json()["id"]
    cliente.post(f"/models/{model_id}/scan", files={"foto": ("d.jpg", b"falso", "image/jpeg")})

    texto = cliente.get(f"/models/{model_id}/export.sql").content.decode("utf-8")
    assert 'CREATE TABLE "Cliente"' in texto
    assert '"CLI_ID" NUMBER(8) NOT NULL' in texto


def test_una_segunda_foto_no_pisa_lo_confirmado(cliente: TestClient, con_ocr_y_llm_falsos) -> None:
    model_id = cliente.post("/models", json={"nombre": "Banco"}).json()["id"]
    escaneo = cliente.post(
        f"/models/{model_id}/scan", files={"foto": ("d.jpg", b"falso", "image/jpeg")}
    ).json()

    pk = next(q for q in escaneo["questions"] if q["kind"] == "primary_key")
    cliente.post(
        f"/models/{model_id}/answers",
        json=[{"question_id": pk["id"], "value": "CLI_NIF", "apply": "key", "target": "CLIENTE"}],
    )

    # Segunda foto: el LLM sigue proponiendo CLI_ID como PK.
    segundo = cliente.post(
        f"/models/{model_id}/scan", files={"foto": ("d2.jpg", b"falso", "image/jpeg")}
    ).json()

    pk_actual = next(
        k for k in segundo["model"]["tables"][0]["keys"] if k["is_primary"]
    )
    assert pk_actual["columns"] == ["CLI_NIF"], "la PK confirmada no puede cambiar sola"


def test_foto_vacia_da_error_claro(cliente: TestClient) -> None:
    model_id = cliente.post("/models", json={"nombre": "Banco"}).json()["id"]
    respuesta = cliente.post(
        f"/models/{model_id}/scan", files={"foto": ("vacia.jpg", b"", "image/jpeg")}
    )
    assert respuesta.status_code == 400
    assert "vacía" in respuesta.json()["detail"]


def test_modelo_inexistente_da_404(cliente: TestClient) -> None:
    assert cliente.get("/models/9999").status_code == 404
