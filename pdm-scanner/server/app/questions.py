"""
Preguntas adaptativas.

El principio es: preguntar, no inventar. Un `.pdm` sin clave primaria abre,
pero no sirve de nada; y una FK apuntando a la columna equivocada genera DDL
que no se parece a lo que hay en la base de datos.

Cada pregunta nace de una comprobacion concreta sobre el modelo, lleva sus
opciones ya calculadas y explica por que se hace. La app no decide: pinta la
pregunta y devuelve el valor.
"""

from __future__ import annotations

import re

from .schema import Confidence, DataModel, Question, QuestionKind

# Convenciones con las que se propone una PK, pero nunca se da por buena.
CONVENCIONES_PK = (
    re.compile(r"^(?P<tabla>.+?)_?ID$", re.IGNORECASE),
    re.compile(r"^ID_(?P<tabla>.+)$", re.IGNORECASE),
    re.compile(r"^(?P<tabla>.+?)_?CODE$", re.IGNORECASE),
    re.compile(r"^(?P<tabla>.+?)_?COD$", re.IGNORECASE),
)

# Tipos que en un diagrama suelen venir sin longitud y hay que concretar.
TIPOS_SIN_LONGITUD = {"VARCHAR", "VARCHAR2", "CHAR", "NVARCHAR", "STRING", "TEXT"}


def _id(parts: list[str]) -> str:
    return "_".join(p for p in parts if p)


def questions_for(model: DataModel) -> list[Question]:
    """Lista de preguntas que hacen falta para que el .pdm sea utilizable."""
    preguntas: list[Question] = []
    vistas: set[str] = set()

    def anadir(pregunta: Question) -> None:
        if pregunta.id in vistas:
            return
        vistas.add(pregunta.id)
        preguntas.append(pregunta)

    for tabla in model.tables:
        # --- Clave primaria: obligatoria ---------------------------------
        primary = tabla.primary_key
        if primary is None:
            candidatas = [c for c in tabla.columns if _casilla_id(c.code)]
            nombres = [f"{c.code} (suele ser clave)" for c in candidatas[:4]]
            anadir(
                Question(
                    id=_id(["pk", tabla.code]),
                    kind=QuestionKind.primary_key,
                    question=f"¿Cuál es la clave primaria de {tabla.name}?",
                    table=tabla.code,
                    options=nombres,
                    reason="sin clave primaria el .pdm no genera DDL y PowerDesigner avisa",
                )
            )
        elif primary.confidence != Confidence.confirmed:
            anadir(
                Question(
                    id=_id(["pk_confirmar", tabla.code]),
                    kind=QuestionKind.primary_key,
                    question=(
                        f"He deducido que la clave primaria de {tabla.name} es "
                        f"({', '.join(primary.columns)}). ¿Es correcto?"
                    ),
                    table=tabla.code,
                    options=[", ".join(primary.columns), "No, es otra"],
                    reason="deducido por el nombre de las columnas, no está escrito en el diagrama",
                )
            )

        # --- Tipos y nulabilidad ----------------------------------------
        for columna in tabla.columns:
            tipo = (columna.data_type or "").strip().upper()
            if tipo in TIPOS_SIN_LONGITUD and not columna.length:
                anadir(
                    Question(
                        id=_id(["len", tabla.code, columna.code]),
                        kind=QuestionKind.column_type,
                        question=(
                            f"¿De qué tamaño es {tabla.name}.{columna.name} "
                            f"(aparece como {columna.data_type} sin longitud)?"
                        ),
                        table=tabla.code,
                        column=columna.code,
                        options=["VARCHAR2(50)", "VARCHAR2(100)", "VARCHAR2(255)", "VARCHAR2(4000)"],
                        reason="en Oracle VARCHAR2 sin longitud no es válido",
                    )
                )

            if columna.mandatory is None:
                anadir(
                    Question(
                        id=_id(["null", tabla.code, columna.code]),
                        kind=QuestionKind.nullability,
                        question=(
                            f"¿{tabla.name}.{columna.name} admite NULL o es obligatoria (NOT NULL)?"
                        ),
                        table=tabla.code,
                        column=columna.code,
                        options=["NOT NULL", "NULL"],
                        reason="el diagrama no lo indica y cambia el DDL",
                    )
                )

            if _parece_id(columna.code) and tabla.primary_key is not None:
                if columna.code not in (tabla.primary_key.columns or []):
                    anadir(
                        Question(
                            id=_id(["identity", tabla.code, columna.code]),
                            kind=QuestionKind.identity,
                            question=(
                                f"¿{tabla.name}.{columna.name} es autoincremental (IDENTITY)?"
                            ),
                            table=tabla.code,
                            column=columna.code,
                            options=["Sí, autoincremental", "No, se asigna en la aplicación"],
                            reason="el nombre lo sugiere pero no se ve en el diagrama",
                        )
                    )

    # --- Claves foraneas ------------------------------------------------

    nombres_tabla = {t.code.lower() for t in model.tables}
    for fk in model.foreign_keys:
        if fk.confidence != Confidence.confirmed:
            padre = model.table(fk.parent_table)
            clave = padre.primary_key.columns if padre and padre.primary_key else []
            anadir(
                Question(
                    id=_id(["fk_card", fk.name]),
                    kind=QuestionKind.cardinality,
                    question=(
                        f"He visto una relación entre {fk.child_table} y {fk.parent_table}. "
                        f"¿Es N:1 (varias filas hijas por una padre)?"
                    ),
                    table=fk.child_table,
                    options=["Sí, N:1", "No, es N:N", "Es 1:1"],
                    reason="las cardinalidades no se leen bien de una foto",
                )
            )
            anadir(
                Question(
                    id=_id(["fk_delete", fk.name]),
                    kind=QuestionKind.on_delete,
                    question=(
                        f"Si se borra una fila de {fk.parent_table}, ¿qué pasa con las de "
                        f"{fk.child_table}?"
                    ),
                    table=fk.child_table,
                    options=["Restrict (no se borra)", "Cascade (se borran)", "Set Null"],
                    reason="el ON DELETE no aparece en el diagrama",
                )
            )
            if padre is not None and padre.primary_key is None:
                anadir(
                    Question(
                        id=_id(["fk_padre", fk.name]),
                        kind=QuestionKind.foreign_key,
                        question=(
                            f"La relación hacia {fk.parent_table} necesita una clave primaria en "
                            f"esa tabla. ¿Cuál es?"
                        ),
                        table=fk.parent_table,
                        options=[", ".join(clave)] if clave else [],
                        reason="una FK referencia la clave del padre, no sus columnas sueltas",
                    )
                )

    # --- Tablas huerfanas ------------------------------------------------
    for tabla in model.tables:
        if len(tabla.columns) < 2:
            anadir(
                Question(
                    id=_id(["pocas_columnas", tabla.code]),
                    kind=QuestionKind.table_comment,
                    question=(
                        f"Solo he leído {len(tabla.columns)} columna(s) en {tabla.name}. "
                        f"¿Es la tabla completa?"
                    ),
                    table=tabla.code,
                    options=["Sí, es completa", "No, falta parte"],
                    reason="puede que la foto no cubriera la tabla entera",
                )
            )

    # --- Comprobacion de FKs colgantes -----------------------------------
    for fk in model.foreign_keys:
        if fk.parent_table.lower() not in nombres_tabla:
            anadir(
                Question(
                    id=_id(["fk_colgada", fk.name]),
                    kind=QuestionKind.foreign_key,
                    question=(
                        f"La relación {fk.name} apunta a la tabla {fk.parent_table}, "
                        f"que no está en el modelo. ¿Cómo se llama?"
                    ),
                    table=fk.child_table,
                    reason="la tabla padre aún no se ha escaneado",
                )
            )

    return preguntas


def _casilla_id(codigo: str) -> bool:
    return any(patron.match(codigo or "") for patron in CONVENCIONES_PK)


def _parece_id(codigo: str) -> bool:
    codigo = (codigo or "").upper()
    return codigo.endswith("_ID") or codigo.startswith("ID_") or codigo == "ID"


def blocking_questions(model: DataModel) -> list[Question]:
    """Las que impiden generar un .pdm utilizable."""
    return [q for q in questions_for(model) if q.kind in (QuestionKind.primary_key, QuestionKind.foreign_key)]


def completion(model: DataModel) -> float:
    """Porcentaje de completitud del modelo, para la barra de la app."""
    total = 0
    hecho = 0
    for tabla in model.tables:
        # Un punto por la clave primaria, dos por columna (tipo y nulabilidad).
        total += 1
        if tabla.primary_key is not None and tabla.primary_key.confidence == Confidence.confirmed:
            hecho += 1
        columnas = tabla.columns or [None]
        for columna in columnas:
            # Dos puntos por columna: tipo (con su longitud) y nulabilidad.
            total += 2
            if columna is None:
                continue
            if columna.data_type and (
                columna.length or columna.data_type.upper() not in TIPOS_SIN_LONGITUD
            ):
                hecho += 1
            if columna.mandatory is not None:
                hecho += 1
    return round(100 * hecho / total, 1) if total else 0.0
