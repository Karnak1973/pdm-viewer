"""
Cliente del LLM local (Ollama) y prompt de extracción.

Nada sale del equipo: se habla con Ollama en 127.0.0.1. La idea es no inventar
nada: el LLM devuelve lo que lee con su confianza, y `questions.py` convierte
lo que no sabe en preguntas para el usuario.

Ollama tiene dos APIs distintas (/api/chat con modelos de tools y
/api/generate clasico). Se usa /api/chat porque es la que respeta el formato
"responde solo JSON" en los modelos de codigo.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any

import httpx

from .schema import Confidence, DataModel, ExtractionEnvelope, ForeignKey, Index, Key, Table

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "http://127.0.0.1:11434"
DEFAULT_MODEL = "qwen2.5-coder:7b"

# Modelos que funcionan bien para esto, por escalón de hardware.
#
# El tiempo de respuesta lo manda la VRAM, no el modelo: un 7B no entra en una
# GPU de 4 GB y se va de CPU, y ahí generation cae a ~2 token/s. Medido en un
# portátil con GTX 1650 (4 GB) y Ryzen 7 4800H:
#
#   qwen2.5-coder:7b  ->  58% CPU / 42% GPU  ->  ~120 s por escaneo
#   qwen2.5-coder:3b  ->  cabe en VRAM        ->  ~35 s por escaneo
#
# Si la primera extracción tarda más de un minuto, el problema no es el código:
# es que el modelo no cabe en la GPU.
MODELOS_RECOMENDADOS = {
    "rapido": ["qwen2.5-coder:3b", "qwen2.5-coder:1.5b", "qwen2.5:3b", "llama3.2:3b"],
    "equilibrado": ["qwen2.5-coder:7b", "qwen2.5:7b", "deepseek-coder-v2:7b", "llama3.1:8b"],
    "vision": ["qwen2.5vl:7b", "qwen2-vl:7b", "llava:7b", "llava-llama3:8b"],
}

SYSTEM_PROMPT = """\
Eres un analista de modelos de datos fisicos. Recibes el texto que un OCR ha
leido de una fotografia de un diagrama, con las coordenadas de cada fragmento.

Tu trabajo es extraer la estructura, NO adivinarla.

Reglas que no puedes romper:
1. No inventes nada. Si un dato no esta en el texto, no lo pongas.
2. Si no sabes cual es la clave primaria de una tabla, deja la tabla sin clave
   y anota la duda en "notes". Es preferible no tener PK a tener una falsa.
3. Si una relacion no indica que columnas unen, dejala fuera de "foreign_keys".
4. Un tipo sin longitud se deja con "length": null. No inventes longitudes.
5. "confidence" vale "inferred" cuando lo deduces por convencion (por ejemplo
   una columna que se llama *_ID) y "pending" cuando no sabeslo.
6. Los codigos se escriben tal cual aparecen, en mayusculas si asi estan.

Responde SOLO con este JSON, sin texto alrededor ni ``` :

{
  "tables": [
    {
      "code": "CLIENTE",
      "name": "Cliente",
      "comment": null,
      "columns": [
        {
          "code": "CLI_ID",
          "name": "CLI_ID",
          "data_type": "NUMBER",
          "length": 8,
          "precision": null,
          "mandatory": true,
          "identity": false,
          "default_value": null,
          "comment": null,
          "confidence": "inferred"
        }
      ],
      "keys": [
        {"name": "PK_CLIENTE", "columns": ["CLI_ID"], "is_primary": true, "confidence": "inferred"}
      ],
      "indexes": [
        {"name": "IX_CLIENTE_NIF", "columns": ["CLI_NIF"], "unique": true, "confidence": "inferred"}
      ]
    }
  ],
  "foreign_keys": [
    {
      "name": "FK_PEDIDO_CLIENTE",
      "parent_table": "CLIENTE",
      "parent_columns": ["CLI_ID"],
      "child_table": "PEDIDO",
      "child_columns": ["PED_CLI"],
      "on_delete": null,
      "on_update": null,
      "confidence": "inferred"
    }
  ],
  "notes": ["No se ve cual es la PK de PEDIDO", "Relacion entre CLIENTE y FACTURA ambigua"]
}
"""


@dataclass
class LlmStatus:
    disponible: bool
    modelo: str
    base_url: str
    modelos_instalados: list[str]
    detalle: str = ""


class LlmNoDisponible(RuntimeError):
    """Ollama no responde o no hay modelos descargados."""


class OllamaClient:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        model: str = DEFAULT_MODEL,
        # 5 minutos: en CPU un 7B puede pasarse de 2 minutos, y cortar la
        # petición a los 30 s solo produce un error inútil.
        timeout: float = 300.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    # -- Estado ---------------------------------------------------------

    def status(self) -> LlmStatus:
        try:
            respuesta = httpx.get(f"{self.base_url}/api/tags", timeout=3.0)
            respuesta.raise_for_status()
            datos = respuesta.json()
            modelos = [m.get("name", "") for m in datos.get("models", [])]
        except Exception as error:  # noqa: BLE001 - aqui es todo "no disponible"
            return LlmStatus(
                disponible=False,
                modelo=self.model,
                base_url=self.base_url,
                modelos_instalados=[],
                detalle=f"no se puede contactar con Ollama en {self.base_url}: {error}",
            )

        if not modelos:
            return LlmStatus(
                disponible=False,
                modelo=self.model,
                base_url=self.base_url,
                modelos_instalados=[],
                detalle="Ollama esta arrancado pero no hay ningun modelo descargado",
            )

        elegido = self.model if self.model in modelos else modelos[0]
        return LlmStatus(disponible=True, modelo=elegido, base_url=self.base_url, modelos_instalados=modelos)

    def ensure_ready(self) -> str:
        estado = self.status()
        if not estado.disponible:
            raise LlmNoDisponible(
                f"{estado.detalle}\n\n"
                "Para arreglarlo:\n"
                "  1. Arranca Ollama (icono en la bandeja del sistema)\n"
                "  2. Descarga un modelo:\n"
                "     ollama pull qwen2.5-coder:7b\n"
            )
        return estado.modelo

    # -- Llamada --------------------------------------------------------

    def _chat(self, system: str, user: str) -> str:
        modelo = self.ensure_ready()
        payload = {
            "model": modelo,
            "stream": False,
            "format": "json",
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            # Temperatura baja: aqui no creativity sino fidelidad al texto.
            "options": {"temperature": 0.1, "num_ctx": 8192},
        }
        try:
            respuesta = httpx.post(f"{self.base_url}/api/chat", json=payload, timeout=self.timeout)
            respuesta.raise_for_status()
        except httpx.HTTPStatusError as error:
            raise LlmNoDisponible(
                f"Ollama respondio {error.response.status_code}. "
                "Prueba otro modelo o reinicia el servicio."
            ) from error
        except httpx.TimeoutException as error:
            raise LlmNoDisponible(
                f"Ollama no ha respondido en {self.timeout:.0f}s.\n\n"
                "Suele ser que el modelo no cabe en la GPU y se ejecuta en CPU. "
                "Prueba con uno más pequeño:\n"
                "  ollama pull qwen2.5-coder:3b\n\n"
                "Y quita el anterior para liberar memoria:\n"
                "  ollama rm qwen2.5-coder:7b"
            ) from error

        return respuesta.json().get("message", {}).get("content", "")

    def extract(self, ocr_prompt: str) -> ExtractionEnvelope:
        """Manda el OCR con coordenadas y devuelve lo parseado."""
        contenido = self._chat(SYSTEM_PROMPT, _build_user_prompt(ocr_prompt))
        datos = _parse_json(contenido)
        return _build_envelope(datos)


def _build_user_prompt(ocr_prompt: str) -> str:
    return f"""\
Aqui esta el texto que el OCR ha leido de la foto del diagrama. Cada linea lleva
su indice y sus coordenadas entre parentesis, para que sepas que columnas
pertenecen a la misma tabla (las de una misma tabla comparten banda horizontal).

{ocr_prompt}

Extrae las tablas, columnas, claves primarias, claves foraneas e indices.
Recuerda: lo que no este en el texto, no lo pongas. Responde solo con el JSON.
"""


def _parse_json(contenido: str) -> dict[str, Any]:
    """Saca el JSON de la respuesta, aunque el modelo meta prosa o vallas."""
    if not contenido:
        raise LlmNoDisponible("Ollama ha devuelto una respuesta vacia")

    texto = contenido.strip()
    try:
        return json.loads(texto)
    except json.JSONDecodeError:
        pass

    # Algunos modelos envuelven el JSON en ```json ... ```
    envuelto = re.search(r"```(?:json)?\s*(.+?)\s*```", texto, re.DOTALL)
    if envuelto:
        try:
            return json.loads(envuelto.group(1))
        except json.JSONDecodeError:
            pass

    # Ultimo recurso: el primer objeto JSON balanceado.
    inicio = texto.find("{")
    fin = texto.rfind("}")
    if inicio != -1 and fin > inicio:
        try:
            return json.loads(texto[inicio : fin + 1])
        except json.JSONDecodeError as error:
            raise LlmNoDisponible(
                "no se ha podido leer el JSON que devuelve el modelo. "
                f"Primeras 300 letras: {texto[:300]}"
            ) from error

    raise LlmNoDisponible(f"el modelo no ha devuelto JSON: {texto[:300]}")


def _confianza(valor: Any) -> Confidence:
    try:
        return Confidence(str(valor).lower())
    except ValueError:
        return Confidence.inferred


def _build_envelope(datos: dict[str, Any]) -> ExtractionEnvelope:
    """Convierte el JSON del LLM en objetos validados.

    Aqui se descarta en silencio lo que no cumple el esquema, y se anota en
    `notes`: es preferible perder una tabla dudosa a que el merge reviente.
    """
    notas: list[str] = list(datos.get("notes") or [])
    tablas: list[Table] = []

    for entrada in datos.get("tables") or []:
        try:
            columnas = []
            for columna in entrada.get("columns") or []:
                if not columna.get("code"):
                    notas.append(f"columna sin code descartada en {entrada.get('code')}")
                    continue
                columnas.append(
                    {
                        "code": str(columna["code"]).strip(),
                        "name": str(columna.get("name") or columna["code"]).strip(),
                        "data_type": str(columna.get("data_type") or "VARCHAR").strip(),
                        "length": _entero(columna.get("length")),
                        "precision": _entero(columna.get("precision")),
                        "mandatory": _booleano(columna.get("mandatory")),
                        "identity": bool(columna.get("identity")),
                        "default_value": columna.get("default_value"),
                        "comment": columna.get("comment"),
                        "confidence": _confianza(columna.get("confidence")),
                    }
                )
            if not columnas:
                notas.append(f"tabla {entrada.get('code')} sin columnas: descartada")
                continue

            codigos = {c["code"].upper() for c in columnas}
            claves = []
            for clave in entrada.get("keys") or []:
                propias = [c for c in (clave.get("columns") or []) if str(c).upper() in codigos]
                if not propias:
                    # Una clave que apunta a columnas que no existen no se
                    # puede escribir en el .pdm: se avisa y se descarta.
                    notas.append(
                        f"clave {clave.get('name')} de {entrada.get('code')} descarta: "
                        "sus columnas no están en la tabla"
                    )
                    continue
                claves.append(
                    {
                        "name": str(clave.get("name") or f"PK_{entrada.get('code')}"),
                        "columns": [str(c) for c in propias],
                        "is_primary": bool(clave.get("is_primary")),
                        "confidence": _confianza(clave.get("confidence")),
                    }
                )

            indices = []
            for indice in entrada.get("indexes") or []:
                propias = [c for c in (indice.get("columns") or []) if str(c).upper() in codigos]
                if not propias:
                    continue
                indices.append(
                    {
                        "name": str(indice.get("name") or f"IX_{entrada.get('code')}"),
                        "columns": [str(c) for c in propias],
                        "unique": bool(indice.get("unique")),
                        "confidence": _confianza(indice.get("confidence")),
                    }
                )

            tablas.append(
                Table(
                    code=str(entrada["code"]).strip(),
                    name=str(entrada.get("name") or entrada["code"]).strip(),
                    comment=entrada.get("comment"),
                    columns=columnas,
                    keys=claves,
                    indexes=indices,
                    confidence=_confianza(entrada.get("confidence")),
                )
            )
        except Exception as error:  # noqa: BLE001 - una tabla mala no puede tirar el escaneo
            notas.append(f"tabla {entrada.get('code')} descartada: {error}")

    # Las PK deducidas por convencion se marcan como inferidas para que
    # questions.py las pregunte en vez de darlas por buenas.
    for tabla in tablas:
        if tabla.primary_key is None:
            candidata = _pk_por_convencion(tabla)
            if candidata is not None:
                tabla.keys.append(candidata)
                notas.append(
                    f"{tabla.code}: propongo PK ({', '.join(candidata.columns)}) por convención, "
                    "conviene confirmarlo"
                )

    tabla_por_codigo = {t.code.upper(): t for t in tablas}
    fks: list[ForeignKey] = []
    for entrada in datos.get("foreign_keys") or []:
        try:
            padre = tabla_por_codigo.get(str(entrada.get("parent_table", "")).upper())
            hija = tabla_por_codigo.get(str(entrada.get("child_table", "")).upper())
            if padre is None or hija is None:
                notas.append(f"FK {entrada.get('name')} descartada: tabla padre o hija no encontrada")
                continue
            if padre.primary_key is None:
                notas.append(
                    f"FK {entrada.get('name')} descartada: {padre.code} no tiene clave primaria"
                )
                continue
            propias_padre = [c for c in entrada.get("parent_columns") or [] if padre.column(c)]
            propias_hija = [c for c in entrada.get("child_columns") or [] if hija.column(c)]
            if not propias_padre or not propias_hija or len(propias_padre) != len(propias_hija):
                notas.append(f"FK {entrada.get('name')} descartada: columnas inconsistentes")
                continue
            fks.append(
                ForeignKey(
                    name=str(entrada.get("name") or f"FK_{hija.code}_{padre.code}"),
                    parent_table=padre.code,
                    parent_columns=[str(c) for c in propias_padre],
                    child_table=hija.code,
                    child_columns=[str(c) for c in propias_hija],
                    on_delete=entrada.get("on_delete"),
                    on_update=entrada.get("on_update"),
                    confidence=_confianza(entrada.get("confidence")),
                )
            )
        except Exception as error:  # noqa: BLE001
            notas.append(f"FK {entrada.get('name')} descartada: {error}")

    return ExtractionEnvelope(tables=tablas, foreign_keys=fks, notes=notas, raw=datos)


def _pk_por_convencion(tabla: Table) -> Key | None:
    """Propone PK siguiendo el nombre, pero solo como sugerencia."""
    codigo = tabla.code.upper()
    for columna in tabla.columns:
        codigo_columna = columna.code.upper()
        if codigo_columna in {f"{codigo}_ID", f"{codigo}ID", f"ID_{codigo}", f"{codigo}_COD", f"{codigo}_CODE"}:
            return Key(
                name=f"PK_{tabla.code}",
                columns=[columna.code],
                is_primary=True,
                confidence=Confidence.pending,
            )
    if len(tabla.columns) == 1:
        return Key(
            name=f"PK_{tabla.code}",
            columns=[tabla.columns[0].code],
            is_primary=True,
            confidence=Confidence.pending,
        )
    return None


def _entero(valor: Any) -> int | None:
    if valor is None or valor == "":
        return None
    try:
        return int(valor)
    except (TypeError, ValueError):
        return None


def _booleano(valor: Any) -> bool | None:
    """El LLM responde true/false, "1"/"0", "NOT NULL"/"NULL" o null."""
    if valor is None or valor == "":
        return None
    if isinstance(valor, bool):
        return valor
    texto = str(valor).strip().lower()
    if texto in {"true", "1", "yes", "y", "not null", "notnull", "mandatory", "obligatorio"}:
        return True
    if texto in {"false", "0", "no", "n", "null", "nullable", "opcional"}:
        return False
    return None
