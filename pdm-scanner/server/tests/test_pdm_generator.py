"""
Prueba de ida y vuelta del .pdm.

El criterio de aceptacion es "PowerDesigner abre el fichero sin errores", que
aqui no se puede comprobar. Lo que si se comprueba, y es lo que mas falla en
la practica, es que el XML generado:

  1. sea well-formed y conserve la instruccion <?PowerDesigner ...?>;
  2. no tenga ids `o<N>` repetidos ni referencias Ref colgantes;
  3. conserve los elementos que PowerDesigner necesita para abrir el modelo
     (ObjectID, Name, Code, Owner, PrimaryKey, TargetModel...);
  4. se pueda releer y devuelva exactamente el modelo que se le dio.

Ese ultimo punto es el que detecta el fallo clasico: una FK que referencia
columnas en vez de la clave del padre, que PowerDesigner descarta en silencio.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from app.pdm.generator import build_pdm
from app.pdm.parse import parse_pdm
from app.schema import Column, Confidence, DataModel, ForeignKey, Index, Key, Table

TEMPLATE = Path(__file__).resolve().parents[1] / "app" / "pdm" / "template.pdm"


def build_model() -> DataModel:
    """Dos tablas con PK de tres columnas, una FK compuesta y un indice."""
    cliente = Table(
        name="Cliente",
        code="CLIENTE",
        comment="Clientes del banco",
        columns=[
            Column(name="CLI_ID", code="CLI_ID", data_type="NUMBER", length=8, mandatory=True),
            Column(name="CLI_OFICIO", code="CLI_OFICIO", data_type="VARCHAR2", length=4, mandatory=True),
            Column(name="CLI_NIF", code="CLI_NIF", data_type="VARCHAR2", length=9, mandatory=True),
            Column(name="CLI_FECHA_ALTA", code="CLI_FECHA_ALTA", data_type="DATE", mandatory=True),
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
            Column(name="PED_ID", code="PED_ID", data_type="NUMBER", length=8, mandatory=True, identity=True),
            Column(name="PED_FECHA", code="PED_FECHA", data_type="DATE", mandatory=True),
            Column(name="PED_IMPORTE", code="PED_IMPORTE", data_type="NUMBER", precision=2, length=12),
            # Columna nullable a proposito: debe salir sin Column.Mandatory.
            Column(name="PED_OBS", code="PED_OBS", data_type="VARCHAR2", length=200, mandatory=False),
        ],
        keys=[Key(name="PK_PEDIDO", columns=["PED_ID"], is_primary=True)],
    )

    return DataModel(
        name="Banco",
        dbms="PostgreSQL 9.x",
        tables=[cliente, pedido],
        foreign_keys=[
            ForeignKey(
                name="FK_PEDIDO_CLIENTE",
                parent_table="CLIENTE",
                parent_columns=["CLI_ID", "CLI_OFICIO", "CLI_NIF"],
                child_table="PEDIDO",
                child_columns=["PED_ID", "PED_IMPORTE", "PED_OBS"],
                on_delete="Restrict",
            )
        ],
    )


@pytest.fixture()
def generated() -> str:
    xml, avisos = build_pdm(build_model(), TEMPLATE)
    # PED_IMPORTE no declara nulabilidad: se asume NULL y se avisa.
    assert any("PED_IMPORTE" in aviso and "nulabilidad" in aviso for aviso in avisos)
    return xml


def test_es_well_formed_y_conserva_la_instruccion_pdm(generated: str) -> None:
    assert generated.startswith('<?xml version="1.0" encoding="UTF-8"?>')
    # Sin esta instruccion PowerDesigner no identifica el fichero.
    assert "<?PowerDesigner" in generated
    assert 'signature="PDM_DATA_MODEL_XML"' in generated
    ET.fromstring(generated)


def test_los_ids_no_se_repiten(generated: str) -> None:
    root = ET.fromstring(generated)
    ids = [element.get("Id") for element in root.iter() if element.get("Id")]
    assert len(ids) == len(set(ids)), "hay ids o<N> repetidos"


def test_no_quedan_referencias_colgantes(generated: str) -> None:
    root = ET.fromstring(generated)
    existentes = {element.get("Id") for element in root.iter() if element.get("Id")}
    colgantes = [
        element.get("Ref")
        for element in root.iter()
        if element.get("Ref") and element.get("Ref") not in existentes
    ]
    assert not colgantes, f"referencias a objetos inexistentes: {colgantes}"


def test_conserva_los_elementos_que_powerdesigner_necesita(generated: str) -> None:
    root = ET.fromstring(generated)
    ns = {"a": "attribute", "c": "collection", "o": "object"}

    assert root.find(".//o:Model", ns) is not None
    # Sin el TargetModel no hay destino de generacion para el modelo.
    assert root.find(".//o:TargetModel", ns) is not None
    assert root.find(".//c:Tables", ns) is not None
    assert root.find(".//c:References", ns) is not None
    assert root.find(".//c:PhysicalDiagrams", ns) is not None

    for table in root.iter("{object}Table"):
        # Solo las definiciones: las referencias `<o:Table Ref="o9"/>` de los
        # simbolos y de las FKs no llevan ObjectID.
        if not table.get("Id"):
            continue
        assert table.findtext("a:ObjectID", namespaces=ns), "tabla sin ObjectID"
        assert table.findtext("a:Code", namespaces=ns), "tabla sin Code"
        # Owner es obligatorio: sin el, PowerDesigner no sabe de quien es la tabla.
        assert table.find("c:Owner", ns) is not None
        # La PK tiene que apuntar a una clave que exista de verdad.
        primary = table.find("c:PrimaryKey", ns)
        if primary is not None:
            key_ref = primary.find("o:Key", ns)
            assert key_ref is not None and key_ref.get("Ref")


def test_id_y_vuelta_conserva_el_modelo(generated: str) -> None:
    original = build_model()
    result = parse_pdm(generated)

    assert result.problems == []
    leido = result.model

    assert leido.name == original.name
    assert [t.code for t in leido.tables] == [t.code for t in original.tables]

    for esperada in original.tables:
        obtenida = leido.table(esperada.code)
        assert obtenida is not None
        assert [c.code for c in obtenida.columns] == [c.code for c in esperada.columns]
        assert [c.data_type for c in obtenida.columns] == [c.data_type for c in esperada.columns]
        assert [c.length for c in obtenida.columns] == [c.length for c in esperada.columns]
        # `.pdm` no puede expresar "nulabilidad desconocida": si no se escribe
        # Column.Mandatory la columna es NULL. El generador avisa de esa
        # conversion, y aqui se comprueba que es la unica perdida.
        for c in obtenida.columns:
            esperada_column = esperada.column(c.code)
            if esperada_column is not None and esperada_column.mandatory is None:
                assert c.mandatory is False
        assert [bool(c.mandatory) for c in obtenida.columns] == [
            bool(c.mandatory) for c in esperada.columns
        ]
        assert [i.name for i in obtenida.indexes] == [i.name for i in esperada.indexes]

        pk_esperada = esperada.primary_key
        pk_obtenida = obtenida.primary_key
        assert pk_obtenida is not None and pk_esperada is not None
        # El orden de las columnas de la PK importa: es el orden del indice.
        assert pk_obtenida.columns == pk_esperada.columns
        assert pk_obtenida.name == pk_esperada.name


def test_id_y_vuelta_conserva_las_relaciones(generated: str) -> None:
    leido = parse_pdm(generated).model
    assert len(leido.foreign_keys) == 1

    fk = leido.foreign_keys[0]
    assert fk.name == "FK_PEDIDO_CLIENTE"
    assert fk.parent_table == "CLIENTE"
    assert fk.child_table == "PEDIDO"
    assert fk.parent_columns == ["CLI_ID", "CLI_OFICIO", "CLI_NIF"]
    assert fk.child_columns == ["PED_ID", "PED_IMPORTE", "PED_OBS"]


def test_la_relacion_apunta_a_la_clave_del_padre_no_a_las_columnas(generated: str) -> None:
    """El fallo clasico: la FK debe referenciar la o:Key del padre."""
    root = ET.fromstring(generated)
    ns = {"a": "attribute", "c": "collection", "o": "object"}

    reference = next(root.iter("{object}Reference"))
    parent_key = reference.find("c:ParentKey", ns)
    assert parent_key is not None, "la FK no referencia c:ParentKey"

    key_ref = parent_key.find("o:Key", ns)
    assert key_ref is not None
    assert key_ref.get("Ref")

    # Ese id tiene que existir y ser una clave real de la tabla padre.
    referenciada = None
    for element in root.iter():
        if element.get("Id") == key_ref.get("Ref"):
            referenciada = element
            break
    assert referenciada is not None, "la FK apunta a una clave que no existe"
    assert referenciada.find("c:Key.Columns", ns) is not None


def test_las_columnas_anulables_no_llevan_mandatory(generated: str) -> None:
    root = ET.fromstring(generated)
    ns = {"a": "attribute", "c": "collection", "o": "object"}

    for column in root.iter("{object}Column"):
        codigo = column.findtext("a:Code", namespaces=ns)
        if codigo in {"PED_OBS"}:
            assert column.find("a:Column.Mandatory", ns) is None
        if codigo in {"PED_ID", "CLI_ID"}:
            assert column.findtext("a:Column.Mandatory", namespaces=ns) == "1"


def test_avisa_si_el_padre_no_tiene_clave_primaria() -> None:
    """Sin PK en el padre la relacion no es representable: se avisa, no se inventa."""
    padre = Table(
        name="Padre",
        code="PADRE",
        columns=[Column(name="P_ID", code="P_ID", data_type="NUMBER", mandatory=True)],
    )
    hija = Table(
        name="Hija",
        code="HIJA",
        columns=[
            Column(name="H_ID", code="H_ID", data_type="NUMBER", mandatory=True),
            Column(name="H_PADRE", code="H_PADRE", data_type="NUMBER", mandatory=True),
        ],
        keys=[Key(name="PK_HIJA", columns=["H_ID"], is_primary=True)],
    )
    modelo = DataModel(
        name="SinPK",
        tables=[padre, hija],
        foreign_keys=[
            ForeignKey(
                name="FK_HIJA_PADRE",
                parent_table="PADRE",
                parent_columns=["P_ID"],
                child_table="HIJA",
                child_columns=["H_PADRE"],
            )
        ],
    )

    xml, avisos = build_pdm(modelo, TEMPLATE)
    assert any("clave primaria" in aviso for aviso in avisos)
    assert "FK_HIJA_PADRE" not in xml
    # El resto del modelo se escribe igualmente.
    assert "P_ID" in xml and "H_PADRE" in xml


def test_el_tamano_no_depende_de_la_plantilla() -> None:
    """La plantilla trae 2 tablas; el modelo tiene 5. Debe reflejarse."""
    tablas = [
        Table(
            name=f"T{i}",
            code=f"T{i}",
            columns=[Column(name=f"C{i}", code=f"C{i}", data_type="NUMBER", mandatory=True)],
            keys=[Key(name=f"PK_T{i}", columns=[f"C{i}"], is_primary=True)],
        )
        for i in range(5)
    ]
    xml, avisos = build_pdm(DataModel(name="Cinco", tables=tablas), TEMPLATE)
    assert avisos == []
    for i in range(5):
        assert f"<a:Code>T{i}</a:Code>" in xml
    assert "Table_1" not in xml, "sobran tablas de la plantilla"
    assert xml.count("<o:Table Id=") == 5


def test_el_diagrama_mete_un_simbolo_por_tabla(generated: str) -> None:
    root = ET.fromstring(generated)
    ns = {"a": "attribute", "c": "collection", "o": "object"}

    diagram = root.find(".//c:PhysicalDiagrams/o:PhysicalDiagram", ns)
    assert diagram is not None
    assert len(diagram.findall("c:Symbols/o:TableSymbol", ns)) == 2

    default = root.find(".//c:DefaultDiagram/o:PhysicalDiagram", ns)
    assert default is not None
    assert default.get("Ref") == diagram.get("Id")


def test_el_id_del_usuario_se_propaga(generated: str) -> None:
    root = ET.fromstring(generated)
    ns = {"a": "attribute", "c": "collection", "o": "object"}
    assert root.findtext(".//o:Model/a:Name", namespaces=ns) == "Banco"


def test_el_rollforward_sobre_la_plantilla_no_rompe_nada(generated: str) -> None:
    """Dos generaciones seguidas dan el mismo resultado: el proceso es estable."""
    primera, avisos_1 = build_pdm(build_model(), TEMPLATE)
    segunda, avisos_2 = build_pdm(build_model(), TEMPLATE)
    assert avisos_1 == avisos_2
    # Solo cambian los GUID y las marcas de tiempo.
    def normalizar(texto: str) -> str:
        texto = re.sub(r"[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}", "GUID", texto)
        return re.sub(r">1\d{9}<", ">FECHA<", texto)

    assert normalizar(primera) == normalizar(segunda)
