"""
Merge incremental.

Al photographic una tabla que ya esta escaneada, la segunda foto no sustituye a
la primera: se fusionan. La regla que manda es que **lo confirmado por el
usuario no se toca nunca**. El LLM puede haber leido mal un diagrama la segunda
vez; el usuario no.

Cada conflicto se devuelve como `Conflict` para que la app decida: aplicar el
cambio o dejarlo como estaba.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from .schema import Column, Confidence, DataModel, ForeignKey, Index, Key, Table


class Field(str, Enum):
    table_name = "table_name"
    column_name = "column_name"
    data_type = "data_type"
    length = "length"
    mandatory = "mandatory"
    identity = "identity"
    default_value = "default_value"
    comment = "comment"
    primary_key = "primary_key"
    foreign_key = "foreign_key"
    index = "index"


@dataclass
class Conflict:
    """Una diferencia entre lo que ya teniamos y lo que ha traido la foto."""

    field: Field
    table: str
    column: str | None
    current: str | None
    incoming: str | None
    resolution: str = Field.__doc__ or "incoming"  # 'current' | 'incoming'
    detail: str = ""

    @property
    def blocking(self) -> bool:
        """Los conflictos que cambian la clave primaria exigen decision."""
        return self.field in (Field.primary_key, Field.data_type)


@dataclass
class MergeReport:
    added_tables: list[str] = field(default_factory=list)
    added_columns: list[tuple[str, str]] = field(default_factory=list)
    removed_columns: list[tuple[str, str]] = field(default_factory=list)
    added_foreign_keys: list[str] = field(default_factory=list)
    added_indexes: list[str] = field(default_factory=list)
    conflicts: list[Conflict] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)

    @property
    def has_conflicts(self) -> bool:
        return bool(self.conflicts)

    def summary(self) -> str:
        partes = []
        if self.added_tables:
            partes.append(f"{len(self.added_tables)} tabla(s) nueva(s)")
        if self.added_columns:
            partes.append(f"{len(self.added_columns)} columna(s) nueva(s)")
        if self.removed_columns:
            partes.append(f"{len(self.removed_columns)} columna(s) eliminada(s)")
        if self.added_foreign_keys:
            partes.append(f"{len(self.added_foreign_keys)} FK nueva(s)")
        if self.added_indexes:
            partes.append(f"{len(self.added_indexes)} indice(s) nuevo(s)")
        if self.conflicts:
            partes.append(f"{len(self.conflicts)} conflicto(s)")
        return ", ".join(partes) if partes else "sin cambios"


def _same(a: object, b: object) -> bool:
    return str(a or "").strip().lower() == str(b or "").strip().lower()


def _merge_column(
    actual: Column, nueva: Column, tabla: str, report: MergeReport
) -> Column:
    """Fusiona una columna existente con la lectura nueva.

    Si el usuario ya confirmo un campo, la foto no puede tocarlo. Si no, se
    acepta lo nuevo y se anota como inferido.
    """
    resultado = actual.model_copy(deep=True)

    if actual.confidence == Confidence.confirmed:
        # Blindado: se ignora cualquier lectura que lo contradiga.
        for nombre, viejo, nuevo in (
            ("data_type", actual.data_type, nueva.data_type),
            ("length", actual.length, nueva.length),
            ("mandatory", actual.mandatory, nueva.mandatory),
            ("identity", actual.identity, nueva.identity),
            ("default_value", actual.default_value, nueva.default_value),
            ("name", actual.name, nueva.name),
            ("comment", actual.comment, nueva.comment),
        ):
            if nuevo is not None and viejo is not None and not _same(viejo, nuevo):
                report.conflicts.append(
                    Conflict(
                        field=Field(nombre),
                        table=tabla,
                        column=actual.code,
                        current=str(viejo),
                        incoming=str(nuevo),
                        resolution="current",
                        detail="valor confirmado por el usuario; se descarta la lectura",
                    )
                )
        return resultado

    for nombre, atributo in (
        ("data_type", "data_type"),
        ("length", "length"),
        ("mandatory", "mandatory"),
        ("identity", "identity"),
        ("default_value", "default_value"),
        ("name", "name"),
        ("comment", "comment"),
    ):
        valor = getattr(nueva, atributo)
        if valor is None or valor == "":
            continue
        if not _same(getattr(actual, atributo), valor):
            if nombre == "data_type" and getattr(actual, atributo):
                report.conflicts.append(
                    Conflict(
                        field=Field.data_type,
                        table=tabla,
                        column=actual.code,
                        current=str(getattr(actual, atributo)),
                        incoming=str(valor),
                        resolution="current",
                        detail="cambio de tipo: puede romper el DDL",
                    )
                )
                continue
            setattr(resultado, atributo, valor)

    return resultado


def _merge_keys(tabla: Table, nueva: Table, report: MergeReport) -> None:
    actuales = {k.name.upper(): k for k in tabla.keys}
    for key in nueva.keys:
        existente = actuales.get(key.name.upper())
        if existente is None:
            # La PK deducida por convencion (columna *_ID) no se acepta sin
            # preguntar: se registra como clave provisional y questions.py la
            # convierte en pregunta.
            tabla.keys.append(key)
            continue
        if not _same(existente.columns, key.columns):
            report.conflicts.append(
                Conflict(
                    field=Field.primary_key if key.is_primary else Field.index,
                    table=tabla.code,
                    column=None,
                    current=", ".join(existente.columns),
                    incoming=", ".join(key.columns),
                    resolution="current",
                    detail="cambian las columnas de la clave",
                )
            )


def _merge_indexes(tabla: Table, nueva: Table, report: MergeReport) -> None:
    actuales = {i.name.upper() for i in tabla.indexes}
    for index in nueva.indexes:
        if index.name.upper() in actuales:
            continue
        # Solo se anaden indices que se han leido con confianza; los dudosos
        # los pregunta questions.py.
        if index.confidence == Confidence.pending:
            report.ignored.append(f"indice {tabla.code}.{index.name} sin confirmar")
            continue
        tabla.indexes.append(index)
        report.added_indexes.append(f"{tabla.code}.{index.name}")


def _merge_foreign_keys(
    actual: DataModel, nueva: DataModel, report: MergeReport
) -> None:
    existentes = {fk.name.upper() for fk in actual.foreign_keys}
    for fk in nueva.foreign_keys:
        if fk.name.upper() in existentes:
            continue
        padre = actual.table(fk.parent_table)
        if padre is None:
            report.ignored.append(
                f"FK {fk.name}: la tabla padre {fk.parent_table} aun no esta escaneada"
            )
            continue
        if padre.primary_key is None:
            report.ignored.append(
                f"FK {fk.name}: {padre.code} no tiene clave primaria confirmada"
            )
            continue
        actual.foreign_keys.append(fk)
        report.added_foreign_keys.append(fk.name)


def merge(base: DataModel, incoming: DataModel) -> tuple[DataModel, MergeReport]:
    """Fusiona `incoming` en `base`. Devuelve el modelo resultante y el informe.

    `base` no se modifica: se trabaja sobre una copia, para que se pueda
    repetir la operacion si el usuario descarta la foto.
    """
    import copy as _copy

    modelo = _copy.deepcopy(base)
    report = MergeReport()

    for tabla_nueva in incoming.tables:
        tabla = modelo.table(tabla_nueva.code)

        if tabla is None:
            modelo.tables.append(_copy.deepcopy(tabla_nueva))
            report.added_tables.append(tabla_nueva.code)
            continue

        if not _same(tabla.name, tabla_nueva.name) and tabla.confidence != Confidence.confirmed:
            report.conflicts.append(
                Conflict(
                    field=Field.table_name,
                    table=tabla.code,
                    column=None,
                    current=tabla.name,
                    incoming=tabla_nueva.name,
                    resolution="current",
                    detail="el diagrama muestra otro nombre",
                )
            )

        for columna_nueva in tabla_nueva.columns:
            columna = tabla.column(columna_nueva.code)
            if columna is None:
                # Columna que no estaba: solo entra si la leemos con confianza.
                if columna_nueva.confidence == Confidence.pending:
                    report.ignored.append(
                        f"columna {tabla.code}.{columna_nueva.code} sin confirmar"
                    )
                    continue
                tabla.columns.append(_copy.deepcopy(columna_nueva))
                report.added_columns.append((tabla.code, columna_nueva.code))
            else:
                fusionada = _merge_column(columna, columna_nueva, tabla.code, report)
                # Se conserva el objeto original para no romper referencias.
                columna.__dict__.update(fusionada.__dict__)

        # Columnas que estaban y ya no se ven. No se borran: puede que la foto
        # solo cubriera parte de la tabla. questions.py lo pregunta.
        for columna in list(tabla.columns):
            if tabla_nueva.column(columna.code) is None and columna.confidence != Confidence.confirmed:
                report.removed_columns.append((tabla.code, columna.code))

        _merge_keys(tabla, tabla_nueva, report)
        _merge_indexes(tabla, tabla_nueva, report)

    _merge_foreign_keys(modelo, incoming, report)

    for origen in incoming.sources:
        if origen not in modelo.sources:
            modelo.sources.append(origen)

    return modelo, report


def apply_answers(model: DataModel, respuestas: list) -> DataModel:
    """Aplica las respuestas del usuario y marca lo confirmado.

    A partir de aqui ese valor ya no lo puede tocar una lectura posterior.
    """
    import copy as _copy

    from .schema import Answer

    modelo = _copy.deepcopy(model)

    for respuesta in respuestas:
        if not isinstance(respuesta, Answer):
            respuesta = Answer.model_validate(respuesta)
        valor = (respuesta.value or "").strip()
        if not valor:
            continue

        if respuesta.apply == "column" and respuesta.column_ref:
            tabla = modelo.table(respuesta.target)
            columna = tabla.column(respuesta.column_ref) if tabla else None
            if columna is None:
                continue
            _aplicar_en_columna(columna, valor)
            columna.confidence = Confidence.confirmed

        elif respuesta.apply == "key":
            tabla = modelo.table(respuesta.target)
            if tabla is None:
                continue
            codigos = [c.strip() for c in valor.split(",") if c.strip()]
            validas = [c for c in codigos if tabla.column(c) is not None]
            if not validas:
                continue
            # Se retira la PK anterior, deducida o confirmada: el usuario acaba
            # de decir cual es. Si se dejara, el .pdm tendria dos claves y la
            # deducida seguiria generando la pregunta de confirmacion.
            nombre_anterior = f"PK_{tabla.code}"
            for key in list(tabla.keys):
                if not key.is_primary:
                    continue
                nombre_anterior = key.name
                tabla.keys.remove(key)
            tabla.keys.append(
                Key(
                    name=nombre_anterior,
                    columns=validas,
                    is_primary=True,
                    confidence=Confidence.confirmed,
                )
            )
            tabla.confidence = Confidence.confirmed

        elif respuesta.apply == "index":
            tabla = modelo.table(respuesta.target)
            if tabla is None:
                continue
            codigos = [c.strip() for c in valor.split(",") if c.strip()]
            validas = [c for c in codigos if tabla.column(c) is not None]
            if not validas:
                continue
            for index in list(tabla.indexes):
                if index.name.upper() == respuesta.value.strip().upper():
                    tabla.indexes.remove(index)
            tabla.indexes.append(
                Index(
                    name=f"IX_{tabla.code}_{validas[0]}",
                    columns=validas,
                    unique=valor.strip().lower().startswith("unique"),
                    confidence=Confidence.confirmed,
                )
            )

        elif respuesta.apply == "foreign_key":
            _aplicar_fk(modelo, respuesta.target, valor)

        else:
            tabla = modelo.table(respuesta.target)
            if tabla is not None:
                tabla.confidence = Confidence.confirmed
                if respuesta.question_id.endswith("comentario"):
                    tabla.comment = valor

    return modelo


def _aplicar_en_columna(columna: Column, valor: str) -> None:
    texto = valor.strip()
    if texto.lower() in {"not null", "obligatoria", "no null"}:
        columna.mandatory = True
    elif texto.lower() in {"null", "opcional", "nullable"}:
        columna.mandatory = False
    elif texto.lower() in {"identity", "autoincremental", "autoincrement"}:
        columna.identity = True
        columna.mandatory = True
    elif texto.lower() in {"serial", "secuencia"}:
        columna.identity = True
    elif re_tiene_longitud(texto):
        tipo, longitud, precision = parse_tipo(texto)
        if tipo:
            columna.data_type = tipo
        if longitud is not None:
            columna.length = longitud
        if precision is not None:
            columna.precision = precision
    elif texto:
        columna.data_type = texto


def re_tiene_longitud(texto: str) -> bool:
    return "(" in texto and ")" in texto


def parse_tipo(texto: str) -> tuple[str | None, int | None, int | None]:
    """`VARCHAR2(50)` -> ('VARCHAR2', 50, None); `NUMBER(12,2)` -> (...,12,2)."""
    import re

    coincidencia = re.match(r"\s*([A-Za-z0-9_ ]+?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)", texto)
    if not coincidencia:
        return (texto.strip() or None), None, None
    tipo, longitud, precision = coincidencia.groups()
    return tipo.upper(), int(longitud), int(precision) if precision else None


def _aplicar_fk(modelo: DataModel, nombre_objetivo: str, valor: str) -> None:
    """Espera `PADRE(a,b) <- HIJA(c,d)`. Formato pensado para la app."""
    import re

    coincidencia = re.match(
        r"\s*(?P<padre>[A-Za-z0-9_]+)\s*\((?P<pc>[^)]*)\)\s*(?:<-|->)\s*(?P<hija>[A-Za-z0-9_]+)\s*\((?P<hc>[^)]*)\)",
        valor,
    )
    if not coincidencia:
        return
    padre = modelo.table(coincidencia.group("padre"))
    hija = modelo.table(coincidencia.group("hija"))
    if padre is None or hija is None:
        return
    columnas_padre = [c.strip() for c in coincidencia.group("pc").split(",") if c.strip()]
    columnas_hija = [c.strip() for c in coincidencia.group("hc").split(",") if c.strip()]
    if not columnas_padre or len(columnas_padre) != len(columnas_hija):
        return
    if padre.primary_key is None:
        return

    modelo.foreign_keys.append(
        ForeignKey(
            name=f"FK_{hija.code}_{padre.code}",
            parent_table=padre.code,
            parent_columns=columnas_padre,
            child_table=hija.code,
            child_columns=columnas_hija,
            confidence=Confidence.confirmed,
        )
    )
