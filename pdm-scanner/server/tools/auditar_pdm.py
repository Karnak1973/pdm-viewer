"""
Auditoría de un .pdm generado: lo compara con un .pdm real de PowerDesigner.

No sustituye a abrirlo en PowerDesigner, pero detecta lo que más se cuela sin
querer: que al generar falte un elemento que el formato real sí trae. La idea
es comparar la "firma" de cada tipo de objeto (qué hijos y qué atributos
lleva) en el fichero real y en el generado.

    python tools/auditar_pdm.py generado.pdm [referencia.pdm]

Sale con 0 si no encuentra nada sospechoso.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PLANTILLA = RAIZ / "app" / "pdm" / "template.pdm"

NS = {"a": "attribute", "c": "collection", "o": "object"}
A, C, O = (f"{{{v}}}" for v in ("attribute", "collection", "object"))

PREFIJOS = {A: "a", C: "c", O: "o"}

# Objetos que PowerDesigner trata como definiciones (tienen Id propio).
OBJETOS = ["Table", "Column", "Key", "Index", "IndexColumn", "Reference", "ReferenceJoin", "Model"]

# Elementos que, si faltan, hacen que PowerDesigner no abra o descarte algo.
VITALES = {
    "Table": ["a:ObjectID", "a:Name", "a:Code", "c:Columns", "c:Owner"],
    "Column": ["a:ObjectID", "a:Name", "a:Code", "a:DataType"],
    "Key": ["a:ObjectID", "a:Name", "c:Key.Columns"],
    "Index": ["a:ObjectID", "a:Name", "c:IndexColumns", "c:BaseIndex.Owner"],
    "Reference": ["a:ObjectID", "a:Name", "c:ParentTable", "c:ChildTable", "c:ParentKey", "c:Joins"],
}


def _nombre(tag: str) -> str:
    if tag.startswith("{"):
        uri, local = tag[1:].split("}")
        return f"{PREFIJOS.get(uri, '?')}:{local}"
    return tag


def firma(raiz: ET.Element) -> dict[str, dict[str, object]]:
    """Para cada tipo de objeto: qué hijos tiene y qué atributos."""
    resultado: dict[str, dict[str, object]] = {}

    for elemento in raiz.iter():
        if not elemento.tag.startswith(O):
            continue
        tipo = elemento.tag[len(O) :]
        if tipo not in OBJETOS or not elemento.get("Id"):
            continue

        hijos = {_nombre(h.tag) for h in elemento}
        # `.attrib`, no iterar el elemento: iterarlo devuelve los hijos.
        atributos = {f"@{clave}" for clave in elemento.attrib}
        entrada = resultado.setdefault(tipo, {"hijos": set(), "atributos": set(), "cuenta": 0})
        entrada["hijos"] |= hijos
        entrada["atributos"] |= atributos
        entrada["cuenta"] = int(entrada["cuenta"]) + 1

    return resultado


def referencias_colgantes(raiz: ET.Element) -> list[str]:
    existentes = {e.get("Id") for e in raiz.iter() if e.get("Id")}
    return [e.get("Ref") or "" for e in raiz.iter() if e.get("Ref") and e.get("Ref") not in existentes]


def ids_repetidos(raiz: ET.Element) -> list[str]:
    vistos: dict[str, int] = defaultdict(int)
    for elemento in raiz.iter():
        identificador = elemento.get("Id")
        if identificador:
            vistos[identificador] += 1
    return [k for k, v in vistos.items() if v > 1]


def auditar(generado: Path, referencia: Path) -> int:
    raiz_gen = ET.fromstring(generado.read_text(encoding="utf-8"))
    problemas = 0

    print(f"generado:   {generado.name}")
    print(f"referencia: {referencia.name}\n")

    # --- 1. Elementos vitales ------------------------------------------
    print("1. Elementos que el formato real trae y el generado no")
    faltantes = 0
    for tipo, requeridos in VITALES.items():
        nodos = [e for e in raiz_gen.iter(f"{O}{tipo}") if e.get("Id")]
        if not nodos:
            continue
        for requerido in requeridos:
            if not all(nodo.find(requerido, NS) is not None for nodo in nodos):
                faltan = sum(1 for nodo in nodos if nodo.find(requerido, NS) is None)
                print(f"   FALTA {requerido} en {faltan}/{len(nodos)} nodos {tipo}")
                faltantes += 1
    if not faltantes:
        print("   ok, todos los elementos vitales están")
    problemas += faltantes

    # --- 2. Hijos que tiene el real y no el generado --------------------
    print("\n2. Hijos presentes en el real y ausentes en el generado")
    firma_gen = firma(raiz_gen)
    firma_ref = firma(ET.fromstring(referencia.read_text(encoding="utf-8")))
    ausentes = 0
    for tipo, referencia_tipo in firma_ref.items():
        if tipo not in firma_gen:
            continue
        diferencia = set(referencia_tipo["hijos"]) - set(firma_gen[tipo]["hijos"])
        diferencia_atributos = set(referencia_tipo["atributos"]) - set(firma_gen[tipo]["atributos"])
        if diferencia:
            print(f"   {tipo}: {sorted(diferencia)}")
            ausentes += 1
        if diferencia_atributos:
            print(f"   {tipo} (atributos): {sorted(diferencia_atributos)}")
            ausentes += 1
    if not ausentes:
        print("   ok, el generado trae todo lo que trae el real")
    problemas += ausentes

    # --- 3. Integridad referencial --------------------------------------
    print("\n3. Integridad")
    colgantes = referencias_colgantes(raiz_gen)
    repetidos = ids_repetidos(raiz_gen)
    if colgantes:
        print(f"   {len(colgantes)} referencias a objetos inexistentes: {sorted(set(colgantes))}")
    else:
        print("   ok, no hay referencias colgantes")
    if repetidos:
        print(f"   ids repetidos: {repetidos}")
    else:
        print("   ok, no hay ids repetidos")
    problemas += len(set(colgantes)) + len(repetidos)

    # --- 4. Cabecera y estructura ---------------------------------------
    print("\n4. Cabecera")
    texto = generado.read_text(encoding="utf-8")
    for comprobacion, etiqueta in (
        (texto.startswith('<?xml version="1.0" encoding="UTF-8"?>'), "declaración XML"),
        ("<?PowerDesigner" in texto, "instrucción <?PowerDesigner"),
        ('signature="PDM_DATA_MODEL_XML"' in texto, "firma PDM_DATA_MODEL_XML"),
        (raiz_gen.find(f".//{O}TargetModel") is not None, "o:TargetModel"),
        (raiz_gen.find(f".//{C}PhysicalDiagrams") is not None, "c:PhysicalDiagrams"),
        (raiz_gen.find(f".//{C}DefaultDiagram") is not None, "c:DefaultDiagram"),
    ):
        print(f"   {'ok ' if comprobacion else 'FALTA'} {etiqueta}")
        if not comprobacion:
            problemas += 1

    # --- 5. Recuento ------------------------------------------------------
    print("\n5. Contenido")
    for tipo, datos in sorted(firma_gen.items()):
        print(f"   {datos['cuenta']:>3} x {tipo}")

    print(f"\n{'TODO CORRECTO' if problemas == 0 else f'{problemas} PROBLEMA(S)'}")
    return problemas


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(
        1
        if auditar(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else PLANTILLA)
        else 0
    )
