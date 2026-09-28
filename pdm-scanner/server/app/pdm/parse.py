"""
Lector de .pdm.

No es un parser de PowerDesigner: es lo justo para comprobar, en los tests y
en el endpoint de validacion, que el XML que genera este proyecto se puede
volver a leer y que conserva lo que el modelo pedia.

Resuelve las referencias internas `Ref="o12"` a nombres, que es donde se
fallan los .pdm mal generados.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

from ..schema import DataModel, Column, ForeignKey, Index, Key, Table

NS = {"a": "attribute", "c": "collection", "o": "object"}
A = f"{{{NS['a']}}}"
C = f"{{{NS['c']}}}"
O = f"{{{NS['o']}}}"


@dataclass
class ParseResult:
    model: DataModel
    problems: list[str] = field(default_factory=list)


def _text(element: ET.Element | None, tag: str, default: str = "") -> str:
    if element is None:
        return default
    child = element.find(tag, NS)
    if child is None or child.text is None:
        return default
    return child.text.strip()


def _int_or_none(value: str) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _resolve(root: ET.Element, ref: str | None) -> ET.Element | None:
    """Busca el elemento con ese Id en todo el documento."""
    if not ref:
        return None
    for element in root.iter():
        if element.get("Id") == ref:
            return element
    return None


def parse_pdm(xml_text: str) -> ParseResult:
    """Lee un .pdm y devuelve el modelo equivalente."""
    problems: list[str] = []
    root = ET.fromstring(xml_text)

    model_node = root.find(f".//{O}Model")
    model = DataModel(name=_text(model_node, A + "Name", "Modelo"))

    # Tablas
    for table_node in root.iter(O + "Table"):
        # `iter` también pasa por las referencias (`<o:Table Ref="o9"/>`) que
        # hay en los símbolos del diagrama y en las propias FKs. Esas no
        # tienen Id, así que el filtro las descarta.
        if not table_node.get("Id"):
            continue
        code = _text(table_node, A + "Code")
        if not code:
            continue
        table = Table(name=_text(table_node, A + "Name", code), code=code)
        comment = _text(table_node, A + "Comment")
        if comment:
            table.comment = comment

        for column_node in table_node.iter(O + "Column"):
            column_code = _text(column_node, A + "Code")
            if not column_code:
                continue
            mandatory = _text(column_node, A + "Column.Mandatory")
            column = Column(
                name=_text(column_node, A + "Name", column_code),
                code=column_code,
                data_type=_text(column_node, A + "DataType", "VARCHAR"),
                length=_int_or_none(_text(column_node, A + "Length")) or None,
                precision=_int_or_none(_text(column_node, A + "Precision")) or None,
                mandatory=mandatory == "1" if mandatory else False,
                identity=_text(column_node, A + "Column.Identity") == "1",
            )
            table.columns.append(column)

        # Claves
        primary_key_ref: str | None = None
        primary_node = table_node.find(C + "PrimaryKey", NS)
        if primary_node is not None:
            key_ref_node = primary_node.find(O + "Key")
            if key_ref_node is not None:
                primary_key_ref = key_ref_node.get("Ref")

        for key_node in table_node.iter(O + "Key"):
            key_name = _text(key_node, A + "Name")
            if not key_name:
                continue
            columns: list[str] = []
            for column_ref in key_node.iter(O + "Column"):
                resolved = _resolve(root, column_ref.get("Ref"))
                if resolved is not None:
                    column_code = _text(resolved, A + "Code")
                    if column_code:
                        columns.append(column_code)
            if not columns:
                continue
            table.keys.append(
                Key(
                    name=key_name,
                    columns=columns,
                    is_primary=key_node.get("Id") == primary_key_ref,
                )
            )

        # Indices
        for index_node in table_node.iter(O + "Index"):
            index_name = _text(index_node, A + "Name")
            if not index_name:
                continue
            columns = [
                _text(expression_node, A + "IndexColumn.Expression")
                for expression_node in index_node.iter(O + "IndexColumn")
            ]
            columns = [code for code in columns if code]
            if not columns:
                continue
            table.indexes.append(
                Index(
                    name=index_name,
                    columns=columns,
                    unique=_text(index_node, A + "Unique") == "1",
                )
            )

        model.tables.append(table)

    # Referencias
    for reference_node in root.iter(O + "Reference"):
        # Igual que con las tablas, `iter` también pasa por las referencias
        # (`<o:Reference Ref="o8"/>`), que son el símbolo de la relación en el
        # diagrama y salen **antes** que la definición. Sin este filtro, leer
        # un .pdm real da un aviso de "referencia incompleta" que no existe.
        if not reference_node.get("Id"):
            continue
        name = _text(reference_node, A + "Name")
        parent_table = _resolve_table_code(root, reference_node.find(C + "ParentTable", NS))
        child_table = _resolve_table_code(root, reference_node.find(C + "ChildTable", NS))
        if not name or not parent_table or not child_table:
            problems.append(f"referencia incompleta: {name or '(sin nombre)'}")
            continue

        parent_columns: list[str] = []
        child_columns: list[str] = []
        for join in reference_node.iter(O + "ReferenceJoin"):
            object1 = join.find(C + "Object1", NS)
            object2 = join.find(C + "Object2", NS)
            for container, sink in ((object1, parent_columns), (object2, child_columns)):
                if container is None:
                    continue
                column_ref = container.find(O + "Column")
                resolved = _resolve(root, column_ref.get("Ref") if column_ref is not None else None)
                if resolved is not None:
                    code = _text(resolved, A + "Code")
                    if code:
                        sink.append(code)

        if not parent_columns or not child_columns:
            problems.append(f"la referencia {name} no resuelve columnas")
            continue

        model.foreign_keys.append(
            ForeignKey(
                name=name,
                parent_table=parent_table,
                parent_columns=parent_columns,
                child_table=child_table,
                child_columns=child_columns,
            )
        )

    return ParseResult(model=model, problems=problems)


def _resolve_table_code(root: ET.Element, container: ET.Element | None) -> str | None:
    if container is None:
        return None
    table_ref = container.find(O + "Table")
    if table_ref is None:
        return None
    resolved = _resolve(root, table_ref.get("Ref"))
    if resolved is None:
        return None
    return _text(resolved, A + "Code") or None
