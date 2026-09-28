"""
Generador de .pdm a partir de un `DataModel`.

El formato .pdm es propietario y no está documentado, así que en vez de
inventar el XML se clona la estructura de una plantilla real
(`template.pdm`, un .pdm de PowerDesigner 16.6 con tablas, claves, índices y
una referencia) y se sustituyen los datos. De ese modo heredamos todos los
elementos que no controlamos: `a:PackageOptionsText`, `a:DisplayPreferences`,
`a:FontList` y compañía.

Estructura que se respeta, sacada de inspeccionar la plantilla:

    o:Table      -> a:Name, a:Code, c:Columns, c:Keys, c:Indexes, c:Owner,
                    c:PrimaryKey (apunta a un o:Key por Ref)
    o:Column     -> a:Name, a:Code, a:DataType, a:Length, a:Column.Mandatory
    o:Key        -> c:Key.Columns -> o:Column Ref
    o:Index      -> a:Unique, c:IndexColumns -> o:IndexColumn
                    (a:IndexColumn.Expression = codigo de columna)
    o:Reference  -> a:Cardinality, a:DeleteConstraint, a:UpdateConstraint,
                    c:ParentTable, c:ChildTable, c:ParentKey (Ref a o:Key),
                    c:Joins -> o:ReferenceJoin (c:Object1 / c:Object2)

Detalle que se pasa por alto: la FK no referencia columnas del padre
sino su **clave** (`c:ParentKey`). Si el padre no tiene ninguna `o:Key`
declarada, la relacion no abre en PowerDesigner aunque las columnas coincidan.
"""

from __future__ import annotations

import copy
import re
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable

from ..schema import DataModel, ForeignKey, Key, Table

NS = {"a": "attribute", "c": "collection", "o": "object"}
for _prefix, _uri in NS.items():
    ET.register_namespace(_prefix, _uri)

A = f"{{{NS['a']}}}"
C = f"{{{NS['c']}}}"
O = f"{{{NS['o']}}}"

TEMPLATE_PATH = Path(__file__).with_name("template.pdm")

# Orden de las etiquetas de constraint en PowerDesigner. Coincide con las
# etiquetas numericas que escribe la herramienta.
CONSTRAINT_CODES = {
    "None": 0,
    "Restrict": 1,
    "Cascade": 2,
    "Set Null": 3,
    "Set Default": 4,
}

DEFAULT_CREATOR = "pdm-scanner"
COLUMNS_PER_ROW = 4
SYMBOL_WIDTH = 3462
SYMBOL_HEIGHT = 3999
SYMBOL_GAP = 800


class PdmGenerationError(RuntimeError):
    """La plantilla no tiene la forma que el generador espera."""


# --------------------------------------------------------------------------
# Utilidades XML
# --------------------------------------------------------------------------


def _find(root: ET.Element, path: str) -> ET.Element | None:
    return root.find(path, NS)


def _find_all(root: ET.Element, tag: str) -> list[ET.Element]:
    return list(root.iter(tag))


def _guid() -> str:
    """ObjectID con la forma que usa PowerDesigner (guiones, mayusculas)."""
    return str(uuid.uuid4()).upper()


def _now() -> int:
    return int(time.time())


class IdAllocator:
    """Reparte ids `o<N>` sin colisionar con los que ya trae la plantilla.

    PowerDesigner usa ids cortos y correlativos. Como la plantilla ya ocupa
    o1..o22, empezamos despues del mayor para que las referencias internas no
    apunten a objetos que hemos borrado.
    """

    def __init__(self, root: ET.Element) -> None:
        self._next = 1
        for element in root.iter():
            match = re.fullmatch(r"o(\d+)", element.get("Id", ""))
            if match:
                self._next = max(self._next, int(match.group(1)) + 1)

    def take(self) -> str:
        value = f"o{self._next}"
        self._next += 1
        return value


def _set_text(element: ET.Element, tag: str, value: str) -> ET.Element:
    """Escribe `<tag>value</tag>`, sustituyendo el que hubiera."""
    existing = element.find(tag, NS)
    if existing is not None:
        existing.text = value
        return existing
    child = ET.SubElement(element, tag)
    child.text = value
    return child


def _drop(parent: ET.Element, tag: str) -> None:
    for child in list(parent):
        if child.tag == tag:
            parent.remove(child)


def _set_bool(element: ET.Element, tag: str, value: bool) -> None:
    _set_text(element, tag, "1" if value else "0")


def _stamps(element: ET.Element, creator: str) -> None:
    stamp = str(_now())
    _set_text(element, A + "CreationDate", stamp)
    _set_text(element, A + "ModificationDate", stamp)
    _set_text(element, A + "Creator", creator)
    _set_text(element, A + "Modifier", creator)


def _blueprint(root: ET.Element, tag: str) -> ET.Element:
    """Primera *definicion* de `tag` en la plantilla, como punto de partida.

    Ojo: hay que exigir el atributo `Id`. En el .pdm conviven definiciones
    (`<o:Table Id="o9">`) y referencias al mismo tipo (`<o:Table Ref="o9"/>`),
    y estas ultimas salen antes en el documento. Copiar una referencia como
    blueprint deja el `Ref` pegado al nodo generado y, ademas, sin los hijos
    que si tiene la definicion (c:Owner, a:TotalSavingCurrency...).
    """
    for element in root.iter(tag):
        if element.get("Id"):
            return copy.deepcopy(element)
    raise PdmGenerationError(f"la plantilla no contiene ninguna definicion de {tag}")


# --------------------------------------------------------------------------
# Construccion de nodos
# --------------------------------------------------------------------------


def _build_column(
    blueprint: ET.Element, ids: IdAllocator, code: str, name: str, data_type: str
) -> ET.Element:
    column = copy.deepcopy(blueprint)
    column.set("Id", ids.take())
    _set_text(column, A + "ObjectID", _guid())
    _set_text(column, A + "Name", name)
    _set_text(column, A + "Code", code)
    _set_text(column, A + "DataType", data_type)
    _stamps(column, DEFAULT_CREATOR)
    return column


def _build_key(
    blueprint: ET.Element, ids: IdAllocator, name: str, column_ids: list[str]
) -> ET.Element:
    key = copy.deepcopy(blueprint)
    key.set("Id", ids.take())
    _set_text(key, A + "ObjectID", _guid())
    _set_text(key, A + "Name", name)
    _set_text(key, A + "Code", name)
    _stamps(key, DEFAULT_CREATOR)

    container = key.find(C + "Key.Columns", NS)
    if container is None:
        container = ET.SubElement(key, C + "Key.Columns")
    for child in list(container):
        container.remove(child)
    for column_id in column_ids:
        ET.SubElement(container, O + "Column", {"Ref": column_id})
    return key


def _build_index(
    blueprint: ET.Element,
    index_column_blueprint: ET.Element,
    ids: IdAllocator,
    name: str,
    columns: list[str],
    unique: bool,
) -> ET.Element:
    index = copy.deepcopy(blueprint)
    index.set("Id", ids.take())
    _set_text(index, A + "ObjectID", _guid())
    _set_text(index, A + "Name", name)
    _set_text(index, A + "Code", name)
    _set_bool(index, A + "Unique", unique)
    _stamps(index, DEFAULT_CREATOR)

    container = index.find(C + "IndexColumns", NS)
    if container is None:
        container = ET.SubElement(index, C + "IndexColumns")
    for child in list(container):
        container.remove(child)

    for column_code in columns:
        index_column = copy.deepcopy(index_column_blueprint)
        index_column.set("Id", ids.take())
        _set_text(index_column, A + "ObjectID", _guid())
        _set_text(index_column, A + "IndexColumn.Expression", column_code)
        _stamps(index_column, DEFAULT_CREATOR)
        container.append(index_column)
    return index


def _build_reference(
    blueprint: ET.Element,
    join_blueprint: ET.Element,
    ids: IdAllocator,
    foreign_key: ForeignKey,
    parent_table_id: str,
    child_table_id: str,
    parent_key_id: str,
    parent_column_ids: list[str],
    child_column_ids: list[str],
) -> ET.Element:
    reference = copy.deepcopy(blueprint)
    reference.set("Id", ids.take())
    _set_text(reference, A + "ObjectID", _guid())
    _set_text(reference, A + "Name", foreign_key.name)
    _set_text(reference, A + "Code", foreign_key.name)
    # 0..* es la cardinalidad de la hija en una relacion 1:N.
    _set_text(reference, A + "Cardinality", "0..*")
    # Restrict es lo que trae la plantilla y lo que espera la mayoria: la FK
    # se numera con el indice de CONSTRAINT_CODES, no con un booleano.
    _set_text(
        reference,
        A + "DeleteConstraint",
        str(CONSTRAINT_CODES.get(foreign_key.on_delete or "Restrict", 1)),
    )
    _set_text(
        reference,
        A + "UpdateConstraint",
        str(CONSTRAINT_CODES.get(foreign_key.on_update or "Restrict", 1)),
    )
    _stamps(reference, DEFAULT_CREATOR)

    for container_tag, ref_value in (
        (C + "ParentTable", parent_table_id),
        (C + "ChildTable", child_table_id),
        (C + "ParentKey", parent_key_id),
    ):
        container = reference.find(container_tag, NS)
        if container is None:
            container = ET.SubElement(reference, container_tag)
        for child in list(container):
            container.remove(child)
        tag = O + ("Key" if container_tag == C + "ParentKey" else "Table")
        ET.SubElement(container, tag, {"Ref": ref_value})

    joins = reference.find(C + "Joins", NS)
    if joins is None:
        joins = ET.SubElement(reference, C + "Joins")
    for child in list(joins):
        joins.remove(child)

    for parent_column_id, child_column_id in zip(parent_column_ids, child_column_ids):
        join = copy.deepcopy(join_blueprint)
        join.set("Id", ids.take())
        _set_text(join, A + "ObjectID", _guid())
        _stamps(join, DEFAULT_CREATOR)
        for container_tag, ref_value in (
            (C + "Object1", parent_column_id),
            (C + "Object2", child_column_id),
        ):
            container = join.find(container_tag, NS)
            if container is None:
                container = ET.SubElement(join, container_tag)
            for child in list(container):
                container.remove(child)
            ET.SubElement(container, O + "Column", {"Ref": ref_value})
        joins.append(join)

    return reference


def _build_symbol(
    blueprint: ET.Element,
    ids: IdAllocator,
    table_id: str,
    index: int,
) -> ET.Element:
    symbol = copy.deepcopy(blueprint)
    symbol.set("Id", ids.take())
    _stamps(symbol, DEFAULT_CREATOR)
    x = (index % COLUMNS_PER_ROW) * (SYMBOL_WIDTH + SYMBOL_GAP)
    y = (index // COLUMNS_PER_ROW) * (SYMBOL_HEIGHT + SYMBOL_GAP)
    _set_text(symbol, A + "Rect", f"(({x},{y}), ({x + SYMBOL_WIDTH},{y + SYMBOL_HEIGHT}))")
    container = symbol.find(C + "Object", NS)
    if container is None:
        container = ET.SubElement(symbol, C + "Object")
    for child in list(container):
        container.remove(child)
    ET.SubElement(container, O + "Table", {"Ref": table_id})
    return symbol


# --------------------------------------------------------------------------
# Generador
# --------------------------------------------------------------------------


XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'


def _split_template(text: str) -> tuple[str, str]:
    """Separa el preámbulo (instrucciones y comentarios) del elemento raiz.

    `<?PowerDesigner ...?>` y el aviso "do not edit this file" viven antes de
    `<Model>`, asi que son hermanos del elemento raiz y no salen en
    `ET.tostring(root)`. Sin la instruccion, PowerDesigner no identifica el
    fichero como PDM, de modo que se copia el preámbulo tal cual.
    """
    end_of_declaration = text.find("?>")
    if end_of_declaration == -1:
        return XML_DECLARATION, ""
    rest = text[end_of_declaration + 2 :]
    start_of_root = rest.find("<Model")
    if start_of_root == -1:
        return XML_DECLARATION, ""
    return XML_DECLARATION, rest[:start_of_root]


def build_pdm(
    model: DataModel, template_path: Path | None = None
) -> tuple[str, list[str]]:
    """Convierte un `DataModel` en el texto de un .pdm.

    Devuelve el XML y los avisos de lo que no se ha podido escribir. Un .pdm
    con una relacion huerfana abre igual en PowerDesigner pero pierde la FK, asi
    que avisar es mejor que fallar en silencio.
    """
    path = template_path or TEMPLATE_PATH
    if not path.exists():
        raise PdmGenerationError(f"no encuentro la plantilla en {path}")

    template_text = path.read_text(encoding="utf-8")
    declaration, prologue = _split_template(template_text)

    # insert_pis=True conserva las instrucciones al releer, aunque la
    # serializacion se hace aparte.
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_pis=True))
    root = ET.fromstring(template_text, parser=parser)

    ids = IdAllocator(root)
    tables_container = _find(root, ".//" + C + "Tables")
    references_container = _find(root, ".//" + C + "References")
    if tables_container is None or references_container is None:
        raise PdmGenerationError("la plantilla no tiene c:Tables / c:References")

    table_blueprint = _blueprint(root, O + "Table")
    column_blueprint = _blueprint(root, O + "Column")
    key_blueprint = _blueprint(root, O + "Key")
    index_blueprint = _blueprint(root, O + "Index")
    index_column_blueprint = _blueprint(root, O + "IndexColumn")
    reference_blueprint = _blueprint(root, O + "Reference")
    join_blueprint = _blueprint(root, O + "ReferenceJoin")
    symbol_blueprint = _blueprint(root, O + "TableSymbol")
    diagram_blueprint = _blueprint(root, O + "PhysicalDiagram")

    # Maps para poder resolver las referencias de las FKs.
    table_ids: dict[str, str] = {}
    key_ids: dict[tuple[str, str], str] = {}
    column_ids: dict[tuple[str, str], str] = {}

    for child in list(tables_container):
        tables_container.remove(child)
    for child in list(references_container):
        references_container.remove(child)

    # --- Tablas, columnas, claves e indices ------------------------------

    for table in model.tables:
        node = copy.deepcopy(table_blueprint)
        node.set("Id", ids.take())
        table_id = node.get("Id", "")
        table_ids[table.code.lower()] = table_id
        _set_text(node, A + "ObjectID", _guid())
        _set_text(node, A + "Name", table.name)
        _set_text(node, A + "Code", table.code)
        if table.comment:
            _set_text(node, A + "Comment", table.comment)
        _stamps(node, DEFAULT_CREATOR)

        columns = node.find(C + "Columns", NS)
        if columns is None:
            columns = ET.SubElement(node, C + "Columns")
        for child in list(columns):
            columns.remove(child)

        for column in table.columns:
            built = _build_column(
                column_blueprint, ids, column.code, column.name, column.data_type
            )
            column_id = built.get("Id", "")
            column_ids[(table.code.lower(), column.code.lower())] = column_id
            # La columna de la plantilla trae Length y Precision (venia de un
            # INT8). Si el modelo no las pide, hay que quitarlas: si no, una
            # columna DATE acabaria con Length=8.
            if column.length:
                _set_text(built, A + "Length", str(column.length))
            else:
                _drop(built, A + "Length")
            if column.precision:
                _set_text(built, A + "Precision", str(column.precision))
            else:
                _drop(built, A + "Precision")
            # PowerDesigner solo escribe Column.Mandatory cuando la columna es
            # NOT NULL; si no, se omite el elemento.
            if column.mandatory:
                _set_bool(built, A + "Column.Mandatory", True)
            else:
                _drop(built, A + "Column.Mandatory")
            if column.identity:
                _set_bool(built, A + "Column.Identity", True)
            if column.default_value:
                _set_text(built, A + "DefaultValue", column.default_value)
            if column.comment:
                _set_text(built, A + "Comment", column.comment)
            columns.append(built)

        keys = node.find(C + "Keys", NS)
        if keys is None:
            keys = ET.SubElement(node, C + "Keys")
        for child in list(keys):
            keys.remove(child)

        indexes = node.find(C + "Indexes", NS)
        if indexes is None:
            indexes = ET.SubElement(node, C + "Indexes")
        for child in list(indexes):
            indexes.remove(child)

        # La PrimaryKey tambien viene apuntando a la clave de la plantilla.
        primary_container = node.find(C + "PrimaryKey", NS)
        if primary_container is not None:
            for child in list(primary_container):
                primary_container.remove(child)

        for key in _ordered_keys(table):
            resolved = [
                column_ids[(table.code.lower(), code.lower())]
                for code in key.columns
                if (table.code.lower(), code.lower()) in column_ids
            ]
            if not resolved:
                continue
            built_key = _build_key(key_blueprint, ids, key.name, resolved)
            key_ids[(table.code.lower(), key.name.lower())] = built_key.get("Id", "")
            keys.append(built_key)

        for index in table.indexes:
            columns_ok = [
                code
                for code in index.columns
                if (table.code.lower(), code.lower()) in column_ids
            ]
            if not columns_ok:
                continue
            indexes.append(
                _build_index(
                    index_blueprint, index_column_blueprint, ids, index.name, columns_ok, index.unique
                )
            )

        primary = table.primary_key
        if primary is not None and (table.code.lower(), primary.name.lower()) in key_ids:
            container = node.find(C + "PrimaryKey", NS)
            if container is None:
                container = ET.SubElement(node, C + "PrimaryKey")
            for child in list(container):
                container.remove(child)
            ET.SubElement(container, O + "Key", {"Ref": key_ids[(table.code.lower(), primary.name.lower())]})

        tables_container.append(node)

    # --- Referencias -----------------------------------------------------

    warnings: list[str] = []
    for foreign_key in model.foreign_keys:
        parent = model.table(foreign_key.parent_table)
        child = model.table(foreign_key.child_table)
        if parent is None or child is None:
            warnings.append(
                f"FK {foreign_key.name}: no existe {foreign_key.parent_table} o {foreign_key.child_table}"
            )
            continue

        parent_key = parent.primary_key
        if parent_key is None:
            # Sin clave en el padre la relacion no es representable. Se avisa
            # en vez de emitir un .pdm que PowerDesigner no abriria.
            warnings.append(
                f"FK {foreign_key.name}: {parent.code} no tiene clave primaria, se omite la relacion"
            )
            continue
        if (parent.code.lower(), parent_key.name.lower()) not in key_ids:
            warnings.append(f"FK {foreign_key.name}: no se pudo resolver la clave de {parent.code}")
            continue

        parent_column_ids = [
            column_ids[(parent.code.lower(), code.lower())]
            for code in foreign_key.parent_columns
            if (parent.code.lower(), code.lower()) in column_ids
        ]
        child_column_ids = [
            column_ids[(child.code.lower(), code.lower())]
            for code in foreign_key.child_columns
            if (child.code.lower(), code.lower()) in column_ids
        ]
        if len(parent_column_ids) != len(foreign_key.parent_columns) or len(
            child_column_ids
        ) != len(foreign_key.child_columns):
            warnings.append(f"FK {foreign_key.name}: alguna columna no existe, se omite la relacion")
            continue

        references_container.append(
            _build_reference(
                reference_blueprint,
                join_blueprint,
                ids,
                foreign_key,
                table_ids[parent.code.lower()],
                table_ids[child.code.lower()],
                key_ids[(parent.code.lower(), parent_key.name.lower())],
                parent_column_ids,
                child_column_ids,
            )
        )

    # --- Diagrama --------------------------------------------------------

    diagrams_container = _find(root, ".//" + C + "PhysicalDiagrams")
    if diagrams_container is not None:
        for child in list(diagrams_container):
            diagrams_container.remove(child)

        diagram = copy.deepcopy(diagram_blueprint)
        diagram.set("Id", ids.take())
        _set_text(diagram, A + "ObjectID", _guid())
        _set_text(diagram, A + "Name", model.name)
        _set_text(diagram, A + "Code", model.name)
        _stamps(diagram, DEFAULT_CREATOR)

        symbols = diagram.find(C + "Symbols", NS)
        if symbols is None:
            symbols = ET.SubElement(diagram, C + "Symbols")
        for child in list(symbols):
            symbols.remove(child)

        for index, table in enumerate(model.tables):
            symbols.append(_build_symbol(symbol_blueprint, ids, table_ids[table.code.lower()], index))

        diagrams_container.append(diagram)

        default_diagram = _find(root, ".//" + C + "DefaultDiagram")
        if default_diagram is not None:
            for child in list(default_diagram):
                default_diagram.remove(child)
            ET.SubElement(default_diagram, O + "PhysicalDiagram", {"Ref": diagram.get("Id", "")})

    # --- Nombre del modelo ----------------------------------------------

    model_node = _find(root, ".//" + O + "Model")
    if model_node is not None:
        _set_text(model_node, A + "Name", model.name)
        _set_text(model_node, A + "Code", model.name)

    # El formato .pdm no tiene forma de decir "no se sabe si admite NULL":
    # o se escribe Column.Mandatory o no se escribe. Como no escribirla
    # significa NULL, se assume lo mas permisivo y se avisa, para que el
    # usuario decida antes de gerar el DDL.
    for table in model.tables:
        for column in table.columns:
            if column.mandatory is None:
                warnings.append(
                    f"{table.code}.{column.code}: nulabilidad sin confirmar, se asume NULL"
                )

    xml = ET.tostring(root, encoding="unicode", xml_declaration=False)
    # ElementTree escribe `<x />`; PowerDesigner genera `<x/>`. Es solo
    # cosmetics, pero cuanto mas fiel sea el fichero menos nos apartamos.
    xml = xml.replace(" />", "/>")
    return f"{declaration}\n{prologue}{xml}\n", warnings


def _ordered_keys(table: Table) -> Iterable[Key]:
    """La clave primaria primero: es la que referencian las FKs."""
    primary = table.primary_key
    others = [key for key in table.keys if key is not primary]
    return ([primary] if primary else []) + others


def generate(
    model: DataModel, template_path: Path | None = None
) -> tuple[str, list[str]]:
    """Atajo de `build_pdm` para quien solo quiere el texto."""
    return build_pdm(model, template_path)
