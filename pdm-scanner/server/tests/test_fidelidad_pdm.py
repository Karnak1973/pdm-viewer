"""
Fidelidad de la reconstrucción: el .pdm real, ida y vuelta.

Es la prueba más dura que se puede hacer sin PowerDesigner, y la razón de ser
de este fichero.

La idea: el `template.pdm` es un `.pdm` **real**, hecho por PowerDesigner. Se
lee con `parse.py`, se reconstruye con `generator.py`, y se vuelve a leer. Si
el modelo que sale a la segunda vuelta es igual al de la primera, el
generador no pierde nada de lo que el fichero real contenía: ni una tabla, ni
una columna, ni el orden de las columnas de una PK compuesta, ni un ON DELETE.

No demuestra que PowerDesigner acepte el fichero — eso solo se comprueba
abriéndolo —. Demuestra algo distinto y también importante: que entre el
formato de entrada y el de salida no hay pérdidas. Si un día un .pdm generado
se descarta al abrirlo, el culpable no será el generador.

El caso que más marea es `Key_1`: en el fichero real es la clave primaria de
`Table_1` a través de `c:PrimaryKey`. Si el generador no larespecta, la tabla
sale sin PK y el diagrama parece correcto.
"""

from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from app.pdm.generator import build_pdm
from app.pdm.parse import parse_pdm
from app.schema import DataModel

PLANTILLA = Path(__file__).resolve().parents[1] / "app" / "pdm" / "template.pdm"


@pytest.fixture(scope="module")
def original() -> DataModel:
    """El modelo tal y como se lee del .pdm real."""
    resultado = parse_pdm(PLANTILLA.read_text(encoding="utf-8"))
    assert resultado.problems == [], f"el parser no debe quejarse del real: {resultado.problems}"
    return resultado.model


@pytest.fixture(scope="module")
def reconstruido(original: DataModel) -> DataModel:
    """El mismo modelo, pasado por el generador y releido."""
    xml, avisos = build_pdm(original, PLANTILLA)
    # El real tiene columnas sin nulabilidad declarada, que al regenerar se
    # asumen NULL: es una conversion conocida y buscada, no una pérdida.
    assert all("nulabilidad" in aviso for aviso in avisos) or not avisos

    resultado = parse_pdm(xml)
    assert resultado.problems == [], f"el reconstruido debe releerse limpio: {resultado.problemas}"
    return resultado.model


# --------------------------------------------------------------------------
# Lo que no puede perderse
# --------------------------------------------------------------------------


def test_se_conservan_las_tablas(original: DataModel, reconstruido: DataModel) -> None:
    assert [t.code for t in reconstruido.tables] == [t.code for t in original.tables]
    assert [t.name for t in reconstruido.tables] == [t.name for t in original.tables]


def test_se_conservan_las_columnas_en_orden(original: DataModel, reconstruido: DataModel) -> None:
    for esperada in original.tables:
        obtenida = reconstruido.table(esperada.code)
        assert obtenida is not None
        assert [c.code for c in obtenida.columns] == [c.code for c in esperada.columns]
        assert [c.data_type for c in obtenida.columns] == [c.data_type for c in esperada.columns]
        assert [c.length for c in obtenida.columns] == [c.length for c in esperada.columns]
        assert [bool(c.mandatory) for c in obtenida.columns] == [
            bool(c.mandatory) for c in esperada.columns
        ]


def test_se_conserva_la_clave_primaria_original(original: DataModel, reconstruido: DataModel) -> None:
    """`Key_1` es la PK de `Table_1` vía `c:PrimaryKey`. Si no se respeta, la
    tabla sale sin clave."""
    for esperada in original.tables:
        pk_esperada = esperada.primary_key
        pk_obtenida = reconstruido.table(esperada.code).primary_key
        assert pk_esperada is not None and pk_obtenida is not None
        assert pk_obtenida.name == pk_esperada.name
        assert pk_obtenida.columns == pk_esperada.columns


def test_se_conservan_los_indices(original: DataModel, reconstruido: DataModel) -> None:
    for esperada in original.tables:
        obtenida = reconstruido.table(esperada.code)
        assert [i.name for i in obtenida.indexes] == [i.name for i in esperada.indexes]
        assert [i.unique for i in obtenida.indexes] == [i.unique for i in esperada.indexes]
        for indice_esperado in esperada.indexes:
            indice = next(i for i in obtenida.indexes if i.name == indice_esperado.name)
            assert indice.columns == indice_esperado.columns


def test_se_conserva_la_referencia_original(original: DataModel, reconstruido: DataModel) -> None:
    assert len(reconstruido.foreign_keys) == len(original.foreign_keys)

    for fk_esperada in original.foreign_keys:
        fk = next(f for f in reconstruido.foreign_keys if f.name == fk_esperada.name)
        assert fk.parent_table == fk_esperada.parent_table
        assert fk.child_table == fk_esperada.child_table
        # Este es el detalle fino: una FK compuesta de varias columnas, en orden.
        assert fk.parent_columns == fk_esperada.parent_columns
        assert fk.child_columns == fk_esperada.child_columns


def test_la_referencia_apunta_a_la_clave_del_padre(reconstruido: DataModel) -> None:
    """Que la FK apunte a la clave y no a las columnas sueltas."""
    raiz = ET.fromstring(build_pdm(reconstruido, PLANTILLA)[0])
    for referencia in [n for n in raiz.iter("{object}Reference") if n.get("Id")]:
        clave = referencia.find("c:ParentKey/{object}Key", {"c": "collection", "o": "object"})
        assert clave is not None and clave.get("Ref"), "la FK debe referenciar c:ParentKey"


# --------------------------------------------------------------------------
# La cabecera, que es donde el modelo puede quedar desincronizado
# --------------------------------------------------------------------------


def test_el_nombre_de_la_cabecera_coincide_con_el_del_modelo(reconstruido: DataModel) -> None:
    """Si no coinciden, el modelo aparece con dos nombres distintos."""
    xml = build_pdm(reconstruido, PLANTILLA)[0]
    raiz = ET.fromstring(xml)
    cabecera = xml.split("?>")[1].split("?>")[0]
    nombre_cabecera = re.search(r'\bName="([^"]*)"', cabecera).group(1)
    nombre_modelo = raiz.find(".//{object}Model").findtext("{attribute}Name")
    assert nombre_cabecera == nombre_modelo == reconstruido.name


def test_el_id_de_la_cabecera_coincide_con_el_objectid_del_modelo(reconstruido: DataModel) -> None:
    xml = build_pdm(reconstruido, PLANTILLA)[0]
    raiz = ET.fromstring(xml)
    id_cabecera = re.search(r'<\?PowerDesigner[^>]*\bID="\{([^}]*)\}"', xml).group(1)
    object_id = raiz.find(".//{object}Model").findtext("{attribute}ObjectID")
    assert id_cabecera == object_id


def test_cada_generacion_usa_un_identificador_distinto(reconstruido: DataModel) -> None:
    """Un modelo nuevo no debe reclamar la identidad del que hace de plantilla.

    Con la plantilla, el ObjectID era 32359288-...; si se regenerara el fichero
    con otro nombre y PowerDesigner guardara los dos, se pisarian.
    """
    primero = build_pdm(reconstruido, PLANTILLA)[0]
    segundo = build_pdm(reconstruido, PLANTILLA)[0]
    guid_original = re.search(r"<a:ObjectID>([0-9A-F-]{36})</a:ObjectID>", PLANTILLA.read_text(encoding="utf-8")).group(1)
    guid_primero = re.search(r"<a:ObjectID>([0-9A-F-]{36})</a:ObjectID>", primero).group(1)
    guid_segundo = re.search(r"<a:ObjectID>([0-9A-F-]{36})</a:ObjectID>", segundo).group(1)

    assert guid_primero != guid_original
    assert guid_primero != guid_segundo


def test_la_fecha_de_modificacion_se_actualiza(reconstruido: DataModel) -> None:
    xml = build_pdm(reconstruido, PLANTILLA)[0]
    cabecera = xml[: xml.index("?>") + 2] + xml.split("?>")[1][:2000]
    marca = re.search(r'LastModificationDate="(\d+)"', cabecera).group(1)
    # La de la plantilla es de 2020.
    assert int(marca) > 1_600_000_000
    assert abs(int(marca) - int(time.time())) < 120


# --------------------------------------------------------------------------
# Y una ida y vuelta más, por si algo se degrada al repetir
# --------------------------------------------------------------------------


def test_reconstruir_dos_veces_no_degrada(reconstruido: DataModel) -> None:
    segunda = parse_pdm(build_pdm(reconstruido, PLANTILLA)[0]).model
    tercera = parse_pdm(build_pdm(segunda, PLANTILLA)[0]).model

    firma = lambda m: (  # noqa: E731
        [(t.code, [c.code for c in t.columns], tuple(t.primary_key.columns) if t.primary_key else None) for t in m.tables],
        [(f.name, tuple(f.parent_columns), tuple(f.child_columns)) for f in m.foreign_keys],
    )
    assert firma(segunda) == firma(tercera)

