"""
Pruebas del merge incremental y de las preguntas adaptativas.

Lo que mas duele en produccion es que una foto posterior pise lo que el
usuario ya habia confirmado, o que se invente una clave primaria sin avisar.
Aqui se fijan las dos reglas.
"""

from __future__ import annotations

import pytest

from app.merge import Conflict, apply_answers, merge, parse_tipo
from app.questions import blocking_questions, completion, questions_for
from app.schema import Answer, Column, Confidence, DataModel, ForeignKey, Index, Key, Table


def col(codigo: str, **kwargs) -> Column:
    return Column(
        name=kwargs.pop("name", codigo),
        code=codigo,
        data_type=kwargs.pop("data_type", "VARCHAR2"),
        length=kwargs.pop("length", 50),
        mandatory=kwargs.pop("mandatory", True),
        **kwargs,
    )


def tabla(codigo: str, columnas: list[Column] | None = None, pk: list[str] | None = None, **kwargs) -> Table:
    columnas = columnas or [col(f"{codigo}_ID", data_type="NUMBER", length=8)]
    pk = pk if pk is not None else [columnas[0].code]
    return Table(
        name=kwargs.pop("name", codigo),
        code=codigo,
        columns=columnas,
        keys=kwargs.pop("keys", None) or [Key(name=f"PK_{codigo}", columns=pk, is_primary=True)],
        **kwargs,
    )


# --------------------------------------------------------------------------
# Merge
# --------------------------------------------------------------------------


def test_una_tabla_nueva_se_anade_entera() -> None:
    base = DataModel(name="M", tables=[tabla("A", None)])
    entrante = DataModel(name="M", tables=[tabla("A", None), tabla("B", None)])

    modelo, informe = merge(base, entrante)

    assert [t.code for t in modelo.tables] == ["A", "B"]
    assert informe.added_tables == ["B"]
    assert "1 tabla(s) nueva(s)" in informe.summary()


def test_una_columna_nueva_se_anade_a_una_tabla_existente() -> None:
    base = DataModel(name="M", tables=[tabla("A", [col("A_ID")])])
    entrante = DataModel(
        name="M",
        tables=[tabla("A", [col("A_ID"), col("A_NOMBRE")])],
    )

    modelo, informe = merge(base, entrante)

    assert [c.code for c in modelo.table("A").columns] == ["A_ID", "A_NOMBRE"]
    assert informe.added_columns == [("A", "A_NOMBRE")]


def test_lo_confirmado_por_el_usuario_no_se_pisa() -> None:
    """La regla que mas importa: una foto posterior no toca un dato confirmado."""
    columna_confirmada = col("A_NOMBRE", length=50, confidence=Confidence.confirmed)
    base = DataModel(name="M", tables=[tabla("A", [col("A_ID"), columna_confirmada])])

    entrante = DataModel(
        name="M",
        tables=[
            Table(
                name="A",
                code="A",
                columns=[col("A_ID"), col("A_NOMBRE", length=999)],
                keys=[Key(name="PK_A", columns=["A_ID"], is_primary=True)],
            )
        ],
    )

    modelo, informe = merge(base, entrante)

    assert modelo.table("A").column("A_NOMBRE").length == 50
    conflictos = [c for c in informe.conflicts if c.column == "A_NOMBRE"]
    assert len(conflictos) == 1
    assert conflictos[0].resolution == "current"
    assert "confirmado" in conflictos[0].detail


def test_un_cambio_de_tipo_se_marca_en_vez_de_aplicarse() -> None:
    base = DataModel(name="M", tables=[tabla("A", [col("A_ID"), col("PRECIO", data_type="NUMBER")])])
    entrante = DataModel(
        name="M",
        tables=[tabla("A", [col("A_ID"), col("PRECIO", data_type="VARCHAR2")])],
    )

    modelo, informe = merge(base, entrante)

    # Un cambio de tipo puede romper el DDL: se informa, no se aplica solo.
    assert modelo.table("A").column("PRECIO").data_type == "NUMBER"
    cambio = next(c for c in informe.conflicts if c.field.value == "data_type")
    assert cambio.resolution == "current"
    assert cambio.blocking


def test_lo_no_confirmado_si_se_actualiza() -> None:
    base = DataModel(name="M", tables=[tabla("A", [col("A_ID"), col("A_NOMBRE", length=50)])])
    entrante = DataModel(
        name="M",
        tables=[tabla("A", [col("A_ID"), col("A_NOMBRE", length=120)])],
    )

    modelo, informe = merge(base, entrante)

    assert modelo.table("A").column("A_NOMBRE").length == 120
    assert not informe.conflicts


def test_cambiar_las_columnas_de_la_pk_es_conflicto_bloqueante() -> None:
    base = DataModel(name="M", tables=[tabla("A", [col("A_ID"), col("A_OFICIO")], pk=["A_ID"])])
    entrante = DataModel(
        name="M",
        tables=[tabla("A", [col("A_ID"), col("A_OFICIO")], pk=["A_ID", "A_OFICIO"])],
    )

    modelo, informe = merge(base, entrante)

    assert modelo.table("A").primary_key.columns == ["A_ID"]
    conflicto = next(c for c in informe.conflicts if c.field.value == "primary_key")
    assert conflicto.blocking


def test_una_columna_que_desaparece_no_se_borra() -> None:
    """Puede que la foto solo cubriera parte de la tabla."""
    base = DataModel(name="M", tables=[tabla("A", [col("A_ID"), col("A_EXTRA")])])
    entrante = DataModel(name="M", tables=[tabla("A", [col("A_ID")])])

    modelo, informe = merge(base, entrante)

    assert modelo.table("A").column("A_EXTRA") is not None
    assert informe.removed_columns == [("A", "A_EXTRA")]


def test_una_columna_sin_confianza_no_entra() -> None:
    base = DataModel(name="M", tables=[tabla("A", [col("A_ID")])])
    entrante = DataModel(
        name="M",
        tables=[
            Table(
                name="A",
                code="A",
                columns=[col("A_ID"), col("A_?", confidence=Confidence.pending)],
                keys=[Key(name="PK_A", columns=["A_ID"], isPrimary=True)],
            )
        ],
    )

    modelo, informe = merge(base, entrante)

    assert modelo.table("A").column("A_?") is None
    assert any("sin confirmar" in i for i in informe.ignored)


def test_una_fk_sin_clave_en_el_padre_no_se_acepta() -> None:
    padre = Table(name="P", code="P", columns=[col("P_ID")], keys=[])
    hija = tabla("H", [col("H_ID"), col("H_P")])
    entrante = DataModel(
        name="M",
        tables=[padre, hija],
        foreign_keys=[
            ForeignKey(
                name="FK_H_P",
                parent_table="P",
                parent_columns=["P_ID"],
                child_table="H",
                child_columns=["H_P"],
            )
        ],
    )

    modelo, informe = merge(DataModel(name="M"), entrante)

    assert modelo.table("H") is not None
    assert modelo.foreign_keys == []
    assert any("clave primaria" in i for i in informe.ignored)


def test_una_fk_valida_se_anade() -> None:
    entrante = DataModel(
        name="M",
        tables=[tabla("P", None), tabla("H", [col("H_ID"), col("H_P")])],
        foreign_keys=[
            ForeignKey(
                name="FK_H_P",
                parent_table="P",
                parent_columns=["P_ID"],
                child_table="H",
                child_columns=["H_P"],
            )
        ],
    )

    modelo, informe = merge(DataModel(name="M"), entrante)

    assert [fk.name for fk in modelo.foreign_keys] == ["FK_H_P"]
    assert informe.added_foreign_keys == ["FK_H_P"]


def test_el_merge_no_modifica_el_modelo_original() -> None:
    base = DataModel(name="M", tables=[tabla("A", [col("A_ID")])])
    entrante = DataModel(name="M", tables=[tabla("A", [col("A_ID"), col("A_NUEVA")])])

    merge(base, entrante)

    assert [c.code for c in base.tables[0].columns] == ["A_ID"]


def test_se_registra_de_que_foto_vino_cada_cosa() -> None:
    base = DataModel(name="M", tables=[tabla("A", None)], sources=["foto1.jpg"])
    entrante = DataModel(name="M", tables=[tabla("A", None), tabla("B", None)], sources=["foto2.jpg"])

    modelo, _ = merge(base, entrante)

    assert modelo.sources == ["foto1.jpg", "foto2.jpg"]


# --------------------------------------------------------------------------
# Respuestas
# --------------------------------------------------------------------------


def test_responder_confirma_la_pk() -> None:
    modelo = DataModel(
        name="M",
        tables=[
            Table(name="A", code="A", columns=[col("A_ID"), col("A_NIF")], keys=[]),
        ],
    )

    resultado = apply_answers(
        modelo, [Answer(question_id="pk_A", value="A_ID, A_NIF", apply="key", target="A")]
    )

    pk = resultado.table("A").primary_key
    assert pk is not None
    assert pk.columns == ["A_ID", "A_NIF"]
    assert pk.confidence == Confidence.confirmed


def test_responder_fija_la_nulabilidad() -> None:
    modelo = DataModel(
        name="M", tables=[tabla("A", [col("A_ID"), col("A_NOTA", mandatory=None)])]
    )

    resultado = apply_answers(
        modelo,
        [Answer(question_id="null_A_A_NOTA", value="NULL", apply="column", target="A", column_ref="A_NOTA")],
    )

    columna = resultado.table("A").column("A_NOTA")
    assert columna.mandatory is False
    assert columna.confidence == Confidence.confirmed


def test_responder_fija_el_tipo_con_longitud() -> None:
    modelo = DataModel(
        name="M",
        tables=[tabla("A", [col("A_ID"), col("A_TXT", data_type="VARCHAR", length=None)])],
    )

    resultado = apply_answers(
        modelo,
        [Answer(question_id="len_A_A_TXT", value="VARCHAR2(255)", apply="column", target="A", column_ref="A_TXT")],
    )

    columna = resultado.table("A").column("A_TXT")
    assert (columna.data_type, columna.length) == ("VARCHAR2", 255)


@pytest.mark.parametrize(
    "texto,esperado",
    [
        ("VARCHAR2(50)", ("VARCHAR2", 50, None)),
        ("NUMBER(12,2)", ("NUMBER", 12, 2)),
        ("DATE", ("DATE", None, None)),
    ],
)
def test_parse_tipo(texto: str, esperado: tuple) -> None:
    assert parse_tipo(texto) == esperado


def test_responder_crea_una_fk_descrita_con_texto() -> None:
    modelo = DataModel(
        name="M",
        tables=[tabla("P", None), tabla("H", [col("H_ID"), col("H_P")])],
    )

    resultado = apply_answers(
        modelo,
        [Answer(question_id="fk", value="P(P_ID) <- H(H_P)", apply="foreign_key", target="H")],
    )

    assert len(resultado.foreign_keys) == 1
    fk = resultado.foreign_keys[0]
    assert (fk.parent_table, fk.child_table) == ("P", "H")
    assert fk.confidence == Confidence.confirmed


# --------------------------------------------------------------------------
# Preguntas
# --------------------------------------------------------------------------


def test_pregunta_por_clave_primaria_ausente() -> None:
    modelo = DataModel(
        name="M",
        tables=[Table(name="Cliente", code="CLIENTE", columns=[col("CLIENTE_ID"), col("NOMBRE")], keys=[])],
    )

    preguntas = questions_for(modelo)
    pk = next(q for q in preguntas if q.kind.value == "primary_key")

    assert pk.table == "CLIENTE"
    assert "Cliente" in pk.question
    # Propone la convenciÃ³n, pero no la da por buena.
    assert any("CLIENTE_ID" in opcion for opcion in pk.options)
    assert blocking_questions(modelo)


def test_confirma_una_pk_deducida() -> None:
    modelo = DataModel(
        name="M",
        tables=[tabla("CLIENTE", [col("CLIENTE_ID")], keys=[Key(name="PK_CLIENTE", columns=["CLIENTE_ID"], is_primary=True, confidence=Confidence.inferred)])],
    )

    preguntas = questions_for(modelo)
    assert any(q.kind.value == "primary_key" and "deducido" in q.reason for q in preguntas)


def test_no_pregunta_por_una_pk_ya_confirmada() -> None:
    modelo = DataModel(
        name="M",
        tables=[tabla("CLIENTE", [col("CLIENTE_ID")], keys=[Key(name="PK_CLIENTE", columns=["CLIENTE_ID"], is_primary=True, confidence=Confidence.confirmed)])],
    )

    assert not [q for q in questions_for(modelo) if q.kind.value == "primary_key"]


def test_pregunta_por_longitud_que_falta_en_oracle() -> None:
    modelo = DataModel(
        name="M",
        tables=[tabla("A", [col("A_ID"), col("A_TXT", data_type="VARCHAR2", length=None)])],
    )

    preguntas = questions_for(modelo)
    assert any(q.kind.value == "column_type" and q.column == "A_TXT" for q in preguntas)


def test_pregunta_por_nulabilidad_desconocida() -> None:
    modelo = DataModel(
        name="M", tables=[tabla("A", [col("A_ID"), col("A_X", mandatory=None)])]
    )

    preguntas = questions_for(modelo)
    assert any(q.kind.value == "nullability" and q.column == "A_X" for q in preguntas)


def test_pregunta_por_autoincremental_sugerido_por_el_nombre() -> None:
    modelo = DataModel(
        name="M",
        tables=[tabla("PEDIDO", [col("PEDIDO_ID"), col("PEDIDO_REF")], pk=["PEDIDO_REF"])],
    )

    preguntas = questions_for(modelo)
    assert any(q.kind.value == "identity" and q.column == "PEDIDO_ID" for q in preguntas)


def test_pregunta_por_relacion_no_confirmada() -> None:
    modelo = DataModel(
        name="M",
        tables=[tabla("P", None), tabla("H", [col("H_ID"), col("H_P")])],
        foreign_keys=[
            ForeignKey(
                name="FK_H_P",
                parent_table="P",
                parent_columns=["P_ID"],
                child_table="H",
                child_columns=["H_P"],
                confidence=Confidence.inferred,
            )
        ],
    )

    preguntas = questions_for(modelo)
    assert any(q.kind.value == "cardinality" for q in preguntas)
    assert any(q.kind.value == "on_delete" for q in preguntas)


def test_no_hay_preguntas_duplicadas() -> None:
    modelo = DataModel(
        name="M",
        tables=[tabla("A", [col("A_ID"), col("A_X", mandatory=None, length=None, data_type="VARCHAR2")])],
    )

    ids = [q.id for q in questions_for(modelo)]
    assert len(ids) == len(set(ids))


def test_completion_crece_al_responder() -> None:
    vacio = DataModel(
        name="M",
        tables=[Table(name="A", code="A", columns=[col("A_ID"), col("A_X", mandatory=None, length=None, data_type="VARCHAR2")], keys=[])],
    )
    assert completion(vacio) < 60

    completo = DataModel(
        name="M",
        tables=[tabla("A", [col("A_ID"), col("A_X")], keys=[Key(name="PK_A", columns=["A_ID"], is_primary=True, confidence=Confidence.confirmed)])],
    )
    assert completion(completo) == 100.0


