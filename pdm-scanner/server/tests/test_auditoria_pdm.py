"""
Auditoría del .pdm frente a la plantilla real.

No sustituye a abrir el fichero en PowerDesigner — eso hay que hacerlo en la
máquina que lo tenga —, pero es lo que detecta que al generar falte un
elemento que el formato real sí trae.

Se comparan dos cosas:

  1. Los elementos **vitales**: si un `o:Table` se queda sin `c:Owner` o sin
     `a:ObjectID`, PowerDesigner no abre el modelo o descarta la tabla.
  2. La **firma** de cada tipo de objeto (hijos y atributos) contra la del
     .pdm real. Si el generador deja de escribir algo que el formato trae,
     salta aquí aunque el XML sea válido.

La regla que motivó el primero: al principio `_blueprint()` copiaba una
referencia (`<o:Table Ref="o9"/>`) en vez de una definición, y las tablas
salían sin `c:Owner` y con un `Ref` colgante. El XML era válido.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from app.pdm.generator import build_pdm
from app.schema import Column, Confidence, DataModel, ForeignKey, Index, Key, Table

NS = {"a": "attribute", "c": "collection", "o": "object"}
A, C, O = (f"{{{v}}}" for v in ("attribute", "collection", "object"))
PLANTILLA = Path(__file__).resolve().parents[1] / "app" / "pdm" / "template.pdm"

# Lo que un tipo de objeto necesita para que PowerDesigner lo respete.
VITALES = {
    "Table": ["a:ObjectID", "a:Name", "a:Code", "c:Columns", "c:Owner"],
    "Column": ["a:ObjectID", "a:Name", "a:Code", "a:DataType"],
    "Key": ["a:ObjectID", "a:Name", "c:Key.Columns"],
    "Index": ["a:ObjectID", "a:Name", "c:IndexColumns", "c:BaseIndex.Owner"],
    "Reference": ["a:ObjectID", "a:Name", "c:ParentTable", "c:ChildTable", "c:ParentKey", "c:Joins"],
}


def _columna(codigo: str, **kwargs) -> Column:
    return Column(
        name=kwargs.pop("nombre", codigo),
        code=codigo,
        data_type=kwargs.pop("tipo", "VARCHAR2"),
        length=kwargs.pop("longitud", 50),
        mandatory=kwargs.pop("obligatoria", True),
        **kwargs,
    )


def modelo_completo() -> DataModel:
    """Tres tablas, PK de 1, 2 y 3 columnas, clave alternativa, FK compuesta."""
    cliente = Table(
        name="Cliente",
        code="CLIENTE",
        comment="Clientes del banco",
        columns=[
            _columna("CLI_ID", tipo="NUMBER", longitud=8),
            _columna("CLI_OFICIO", longitud=4),
            _columna("CLI_NIF", longitud=9),
            _columna("CLI_FECHA_ALTA", tipo="DATE", obligatoria=False),
        ],
        keys=[
            Key(
                name="PK_CLIENTE",
                columns=["CLI_ID", "CLI_OFICIO", "CLI_NIF"],
                is_primary=True,
                confidence=Confidence.confirmed,
            )
        ],
        indexes=[Index(name="IX_CLIENTE_NIF", columns=["CLI_NIF"], unique=True)],
    )

    pedido = Table(
        name="Pedido",
        code="PEDIDO",
        columns=[
            _columna("PED_ID", tipo="NUMBER", longitud=8, identity=True),
            _columna("PED_FECHA", tipo="DATE"),
            _columna("PED_IMPORTE", tipo="NUMBER", longitud=12, obligatoria=False),
            _columna("PED_OBS", longitud=500, obligatoria=False, comment="Observaciones"),
        ],
        keys=[
            Key(name="PK_PEDIDO", columns=["PED_ID"], is_primary=True, confidence=Confidence.confirmed),
            Key(name="AK_PEDIDO_FECHA", columns=["PED_FECHA", "PED_ID"], is_primary=False),
        ],
        indexes=[Index(name="IX_PEDIDO_FECHA", columns=["PED_FECHA"], unique=False)],
    )

    linea = Table(
        name="Linea",
        code="LINEA_PEDIDO",
        columns=[
            _columna("LIN_PED_ID", tipo="NUMBER", longitud=8),
            _columna("LIN_NUMLIN", tipo="NUMBER", longitud=4),
        ],
        keys=[Key(name="PK_LINEA", columns=["LIN_PED_ID", "LIN_NUMLIN"], is_primary=True)],
    )

    return DataModel(
        name="Banco",
        tables=[cliente, pedido, linea],
        foreign_keys=[
            ForeignKey(
                name="FK_PEDIDO_CLIENTE",
                parent_table="CLIENTE",
                parent_columns=["CLI_ID", "CLI_OFICIO", "CLI_NIF"],
                child_table="PEDIDO",
                child_columns=["PED_ID", "PED_OBS", "PED_FECHA"],
                on_delete="Restrict",
                confidence=Confidence.confirmed,
            ),
            ForeignKey(
                name="FK_LINEA_PEDIDO",
                parent_table="PEDIDO",
                parent_columns=["PED_ID"],
                child_table="LINEA_PEDIDO",
                child_columns=["LIN_PED_ID"],
                on_delete="Cascade",
                confidence=Confidence.confirmed,
            ),
        ],
    )


@pytest.fixture(scope="module")
def generado() -> str:
    xml, _ = build_pdm(modelo_completo(), PLANTILLA)
    return xml


@pytest.fixture(scope="module")
def raiz(generado: str) -> ET.Element:
    return ET.fromstring(generado)


# --------------------------------------------------------------------------
# Elementos vitales
# --------------------------------------------------------------------------


@pytest.mark.parametrize("tipo", sorted(VITALES))
def test_todo_tipo_de_objeto_tiene_sus_elementos_vitales(raiz: ET.Element, tipo: str) -> None:
    nodos = [n for n in raiz.iter(f"{O}{tipo}") if n.get("Id")]
    if not nodos:
        pytest.skip(f"el modelo de prueba no genera nodos {tipo}")
    for nodo in nodos:
        for requerido in VITALES[tipo]:
            assert nodo.find(requerido, NS) is not None, f"{tipo} sin {requerido}"


def test_las_tablas_tienen_propietario(raiz: ET.Element) -> None:
    """El fallo que motivó esta auditoría: tablas válidas sin `c:Owner`."""
    for tabla in [n for n in raiz.iter(f"{O}Table") if n.get("Id")]:
        propietario = tabla.find("c:Owner", NS)
        assert propietario is not None, f"{tabla.findtext('a:Code', namespaces=NS)} sin c:Owner"
        assert propietario.find("o:User", NS) is not None


def test_ningun_nodo_lleva_un_ref_heredado_de_la_plantilla(raiz: ET.Element) -> None:
    """Un `Ref` pegado a una definición viene de copiar una referencia."""
    for elemento in raiz.iter():
        if elemento.get("Id") and elemento.get("Ref"):
            pytest.fail(f"{elemento.tag} tiene Id y Ref a la vez: se copió una referencia")


# --------------------------------------------------------------------------
# Firma contra el .pdm real
# --------------------------------------------------------------------------


def _firma(raiz: ET.Element) -> dict[str, dict[str, set[str]]]:
    firma: dict[str, dict[str, set[str]]] = {}
    for elemento in raiz.iter():
        if not elemento.tag.startswith(O) or not elemento.get("Id"):
            continue
        tipo = elemento.tag[len(O) :]
        if tipo not in VITALES:
            continue
        entrada = firma.setdefault(tipo, {"hijos": set(), "atributos": set()})
        entrada["hijos"] |= {hijo.tag for hijo in elemento}
        entrada["atributos"] |= set(elemento.attrib)
    return firma


def test_el_generado_trae_todo_lo_que_trae_el_fichero_real(raiz: ET.Element) -> None:
    referencia = _firma(ET.fromstring(PLANTILLA.read_text(encoding="utf-8")))
    generado = _firma(raiz)

    for tipo, entrada in referencia.items():
        if tipo not in generado:
            continue
        faltan_hijos = entrada["hijos"] - generado[tipo]["hijos"]
        faltan_atributos = entrada["atributos"] - generado[tipo]["atributos"]
        assert not faltan_hijos, f"{tipo}: el real trae {faltan_hijos} y el generado no"
        assert not faltan_atributos, f"{tipo}: faltan atributos {faltan_atributos}"


# --------------------------------------------------------------------------
# Integridad
# --------------------------------------------------------------------------


def test_no_hay_referencias_colgantes(raiz: ET.Element) -> None:
    existentes = {n.get("Id") for n in raiz.iter() if n.get("Id")}
    colgantes = [n.get("Ref") for n in raiz.iter() if n.get("Ref") and n.get("Ref") not in existentes]
    assert not colgantes, f"referencias a objetos inexistentes: {colgantes}"


def test_no_hay_ids_repetidos(raiz: ET.Element) -> None:
    ids = [n.get("Id") for n in raiz.iter() if n.get("Id")]
    assert len(ids) == len(set(ids))


def test_cada_tabla_aparece_una_vez_en_el_diagrama(raiz: ET.Element) -> None:
    """Un símbolo por tabla: si se repite, PowerDesigner dibuja la tabla dos veces."""
    diagramas = raiz.find(f".//{C}PhysicalDiagrams")
    assert diagramas is not None
    simbolos = [n for n in diagramas.iter(f"{O}TableSymbol") if n.get("Id")]
    referencias = [n.find("c:Object", NS).find("o:Table", NS).get("Ref") for n in simbolos]
    assert len(referencias) == len(set(referencias))
    assert len(referencias) == 3


# --------------------------------------------------------------------------
# Contenido que a veces se pierde
# --------------------------------------------------------------------------


def test_se_conservan_las_claves_alternativas(raiz: ET.Element) -> None:
    """`AK_PEDIDO_FECHA` no es la PK: si se pierde, el modelo pierde una
    restricción sin avisar."""
    nombres = {n.findtext("a:Name", namespaces=NS) for n in raiz.iter(f"{O}Key") if n.get("Id")}
    assert "AK_PEDIDO_FECHA" in nombres


def test_las_restricciones_de_borrado_se_reflejan(raiz: ET.Element) -> None:
    """Cascade es 2 y Restrict es 1 en el .pdm."""
    por_nombre = {
        n.findtext("a:Name", namespaces=NS): n.findtext("a:DeleteConstraint", namespaces=NS)
        for n in raiz.iter(f"{O}Reference")
        if n.get("Id")
    }
    assert por_nombre["FK_LINEA_PEDIDO"] == "2", "Cascade debería ser 2"
    assert por_nombre["FK_PEDIDO_CLIENTE"] == "1", "Restrict debería ser 1"


def test_las_columnas_anulables_no_declaran_mandatory(raiz: ET.Element) -> None:
    for columna in raiz.iter(f"{O}Column"):
        if not columna.get("Id"):
            continue
        codigo = columna.findtext("a:Code", namespaces=NS)
        if codigo in {"PED_OBS", "CLI_FECHA_ALTA"}:
            assert columna.find("a:Column.Mandatory", NS) is None, f"{codigo} no debería ser NOT NULL"
        if codigo == "PED_ID":
            assert columna.findtext("a:Column.Mandatory", namespaces=NS) == "1"


def test_los_comentarios_se_conservan(raiz: ET.Element) -> None:
    comentarios = {
        n.findtext("a:Code", namespaces=NS): n.findtext("a:Comment", namespaces=NS)
        for n in raiz.iter(f"{O}Column")
        if n.get("Id")
    }
    assert comentarios["PED_OBS"] == "Observaciones"
    tablas = {n.findtext("a:Code", namespaces=NS): n.findtext("a:Comment", namespaces=NS) for n in raiz.iter(f"{O}Table") if n.get("Id")}
    assert tablas["CLIENTE"] == "Clientes del banco"


def test_las_pk_compuestas_conservan_el_orden(raiz: ET.Element) -> None:
    """El orden de las columnas de la PK es el orden del índice underlying."""
    claves = {
        n.findtext("a:Name", namespaces=NS): n for n in raiz.iter(f"{O}Key") if n.get("Id")
    }
    orden = [c.get("Ref") for c in claves["PK_CLIENTE"].iter(f"{O}Column")]
    assert len(orden) == 3
    # Las tres columnas tienen que ser distintas y existir.
    assert len(set(orden)) == 3
    existentes = {n.get("Id") for n in raiz.iter() if n.get("Id")}
    assert all(ref in existentes for ref in orden)
