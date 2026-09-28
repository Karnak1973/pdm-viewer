"""
Pipeline completo de extremo a extremo, con OCR y LLM reales.

Es la prueba que de verdad importa: una foto -> OCR -> LLM local -> merge ->
preguntas -> .pdm. Si esto funciona, el camino feliz funciona; si falla, el
fallo dice en qué punto está.

    python tools/pipeline_completo.py [imagen.jpg] [modelo_ollama]
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from app import ocr  # noqa: E402
from app.llm import OllamaClient  # noqa: E402
from app.merge import merge  # noqa: E402
from app.pdm.generator import build_pdm  # noqa: E402
from app.pdm.parse import parse_pdm  # noqa: E402
from app.questions import completion, questions_for  # noqa: E402
from app.schema import DataModel  # noqa: E402


def main() -> int:
    imagen = Path(sys.argv[1] if len(sys.argv) > 1 else RAIZ / "tools" / "diagrama_falso.jpg")
    modelo = sys.argv[2] if len(sys.argv) > 2 else "qwen2.5-coder:7b-instruct"

    print(f"1. OCR sobre {imagen.name}")
    inicio = time.time()
    resultado_ocr = ocr.run_ocr(imagen.read_bytes(), engine="tesseract")
    print(f"   {len(resultado_ocr.boxes)} fragmentos en {time.time() - inicio:.1f}s\n")

    print(f"2. LLM local ({modelo})")
    inicio = time.time()
    cliente = OllamaClient(model=modelo)
    envelope = cliente.extract(resultado_ocr.as_prompt())
    print(f"   {len(envelope.tables)} tablas y {len(envelope.foreign_keys)} FK en {time.time() - inicio:.1f}s\n")

    for tabla in envelope.tables:
        pk = tabla.primary_key
        print(f"   {tabla.code}  ({len(tabla.columns)} col)")
        print(f"      PK: {pk.columns if pk else 'NINGUNA'}  [{pk.confidence.value if pk else '-'}]")
        for columna in tabla.columns:
            marca = "PK" if pk and columna.code in pk.columns else "  "
            print(
                f"      {marca} {columna.code:16} {columna.display_type:14} "
                f"null={columna.mandatory} conf={columna.confidence.value}"
            )
        for indice in tabla.indexes:
            print(f"      IDX {indice.name} {indice.columns} unique={indice.unique}")
    for fk in envelope.foreign_keys:
        print(f"   FK {fk.name}: {fk.child_table}{fk.child_columns} -> {fk.parent_table}{fk.parent_columns}")

    print("\n3. Merge y preguntas")
    base = DataModel(name="Escaneado")
    modelo_final, informe = merge(base, envelope_tables(envelope))
    preguntas = questions_for(modelo_final)
    print(f"   {informe.summary()}")
    print(f"   {modelo_final.stats()}")
    print(f"   completitud: {completion(modelo_final)}%")
    for pregunta in preguntas:
        opciones = f"  opciones: {pregunta.options}" if pregunta.options else ""
        print(f"   ? [{pregunta.kind}] {pregunta.question}{opciones}")

    print("\n4. Generación del .pdm")
    xml, avisos = build_pdm(modelo_final)
    destino = RAIZ / "tools" / "salida.pdm"
    destino.write_text(xml, encoding="utf-8")
    leido = parse_pdm(xml)
    print(f"   {len(xml) // 1024} kB en {destino}")
    print(f"   avisos: {avisos or 'ninguno'}")
    print(f"   problemas al releer: {leido.problems or 'ninguno'}")
    print(f"   releído: {leido.model.stats()}")
    for tabla in leido.model.tables:
        pk = tabla.primary_key
        print(f"      {tabla.code}: {len(tabla.columns)} col, PK={pk.columns if pk else 'NINGUNA'}")
    for fk in leido.model.foreign_keys:
        print(f"      FK {fk.name}: {fk.child_table} -> {fk.parent_table}")
    return 0 if not leido.problems else 1


def envelope_tables(envelope) -> DataModel:  # noqa: ANN001
    return DataModel(
        name="Escaneado",
        tables=envelope.tables,
        foreign_keys=envelope.foreign_keys,
        sources=["foto.jpg"],
    )


if __name__ == "__main__":
    sys.exit(main())
