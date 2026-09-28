"""
Esquema del modelo de datos reconstruido a partir de fotos.

Este es el unico contrato entre el LLM (que extrae), el merge (que acumula) y
el generador de .pdm (que escribe). Todo lo que el LLM no sepa con certeza se
marca como `inferred` y acaba en una pregunta al usuario, nunca se inventa.

Los identificadores son estables y los genera el extractor; el merge nunca
cambia el id de un objeto que ya existe, porque los .pdm usan referencias
internas por id.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

# --------------------------------------------------------------------------
# Estados de confianza
# --------------------------------------------------------------------------


class Confidence(str, Enum):
    """De donde sale cada dato.

    CONFIRMED: lo ha confirmado el usuario.
    INFERRED: deducido del diagrama o de las convenciones.
    PENDING: no se sabe; genera una pregunta.
    """

    confirmed = "confirmed"
    inferred = "inferred"
    pending = "pending"


# --------------------------------------------------------------------------
# Objetos del modelo
# --------------------------------------------------------------------------


class Column(BaseModel):
    name: str = Field(description="Nombre de la columna tal cual aparece en el diagrama")
    code: str = Field(description="Código físico de la columna")
    data_type: str = Field(default="VARCHAR", description="Tipo de dato tal cual se ve")
    length: int | None = None
    precision: int | None = None
    mandatory: bool | None = Field(
        default=None, description="True=NOT NULL, False=NULL, None=no se sabe"
    )
    identity: bool = False
    default_value: str | None = None
    comment: str | None = None
    confidence: Confidence = Confidence.inferred
    source_box: str | None = Field(
        default=None, description="Coordenadas OCR 'x1,y1,x2,y2' de donde se leyó"
    )

    @field_validator("code", "name")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = (value or "").strip()
        if not value:
            raise ValueError("code y name no pueden estar vacios")
        return value

    @property
    def display_type(self) -> str:
        """Tipo con longitud, como se lee en el diagrama."""
        if self.length and self.precision:
            return f"{self.data_type}({self.length},{self.precision})"
        if self.length:
            return f"{self.data_type}({self.length})"
        return self.data_type


class Key(BaseModel):
    """Clave primaria o alternativa. El .pdm solo tiene un concepto de Key."""

    name: str
    columns: list[str] = Field(description="Códigos de columna que la forman")
    is_primary: bool = False
    confidence: Confidence = Confidence.inferred

    @model_validator(mode="after")
    def _check_columns(self) -> Key:
        if not self.columns:
            raise ValueError(f"la clave {self.name} no tiene columnas")
        return self


class Index(BaseModel):
    name: str
    columns: list[str]
    unique: bool = False
    confidence: Confidence = Confidence.inferred

    @model_validator(mode="after")
    def _check_columns(self) -> Index:
        if not self.columns:
            raise ValueError(f"el indice {self.name} no tiene columnas")
        return self


class ForeignKey(BaseModel):
    name: str
    parent_table: str = Field(description="Código de la tabla referenciada (la PK)")
    parent_columns: list[str]
    child_table: str = Field(description="Código de la tabla que lleva la FK")
    child_columns: list[str]
    on_delete: Literal["None", "Restrict", "Cascade", "Set Null", "Set Default"] | None = None
    on_update: Literal["None", "Restrict", "Cascade", "Set Null", "Set Default"] | None = None
    confidence: Confidence = Confidence.inferred

    @model_validator(mode="after")
    def _check_lengths(self) -> ForeignKey:
        if len(self.parent_columns) != len(self.child_columns):
            raise ValueError(
                f"la FK {self.name} une {len(self.parent_columns)} columnas del padre con "
                f"{len(self.child_columns)} de la hija"
            )
        if not self.child_columns:
            raise ValueError(f"la FK {self.name} no tiene columnas hijas")
        return self


class Table(BaseModel):
    name: str
    code: str
    comment: str | None = None
    columns: list[Column] = Field(default_factory=list)
    keys: list[Key] = Field(default_factory=list)
    indexes: list[Index] = Field(default_factory=list)
    confidence: Confidence = Confidence.inferred

    @field_validator("code", "name")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = (value or "").strip()
        if not value:
            raise ValueError("code y name no pueden estar vacios")
        return value

    @property
    def primary_key(self) -> Key | None:
        for key in self.keys:
            if key.is_primary:
                return key
        return None

    def column(self, code: str) -> Column | None:
        target = code.strip().lower()
        for column in self.columns:
            if column.code.lower() == target or column.name.lower() == target:
                return column
        return None


# --------------------------------------------------------------------------
# Modelo completo
# --------------------------------------------------------------------------


class DataModel(BaseModel):
    """El modelo acumulado. Es lo que se convierte en .pdm."""

    name: str = "Modelo escaneado"
    dbms: str = "PostgreSQL 9.x"
    tables: list[Table] = Field(default_factory=list)
    foreign_keys: list[ForeignKey] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    # Traza de que foto produjo que, para poder volver atrás.
    sources: list[str] = Field(default_factory=list)

    @field_validator("tables")
    @classmethod
    def _unique_table_codes(cls, tables: list[Table]) -> list[Table]:
        seen: set[str] = set()
        for table in tables:
            key = table.code.lower()
            if key in seen:
                raise ValueError(f"tabla duplicada: {table.code}")
            seen.add(key)
        return tables

    def table(self, code: str) -> Table | None:
        target = code.strip().lower()
        for table in self.tables:
            if table.code.lower() == target or table.name.lower() == target:
                return table
        return None

    def stats(self) -> dict[str, int]:
        return {
            "tablas": len(self.tables),
            "columnas": sum(len(t.columns) for t in self.tables),
            "claves_primarias": sum(1 for t in self.tables if t.primary_key),
            "claves_foraneas": len(self.foreign_keys),
            "indices": sum(len(t.indexes) for t in self.tables),
        }


# --------------------------------------------------------------------------
# Preguntas adaptativas
# --------------------------------------------------------------------------


class QuestionKind(str, Enum):
    primary_key = "primary_key"
    identity = "identity"
    column_type = "column_type"
    nullability = "nullability"
    foreign_key = "foreign_key"
    cardinality = "cardinality"
    index = "index"
    on_delete = "on_delete"
    column_name = "column_name"
    table_comment = "table_comment"


class Question(BaseModel):
    """Una pregunta concreta con sus opciones, tal como se la teaching al usuario.

    Se manda a la app tal cual: la app no decide nada, solo pinta y devuelve
    la respuesta chosen.
    """

    id: str = Field(description="Identificador estable para poder responder fuera de orden")
    kind: QuestionKind
    question: str
    table: str | None = None
    column: str | None = None
    options: list[str] = Field(default_factory=list)
    free_text: bool = True
    reason: str = Field(default="", description="Por que se pregunta, en una frase")

    @field_validator("id")
    @classmethod
    def _stable_id(cls, value: str) -> str:
        return re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")


class Answer(BaseModel):
    question_id: str
    value: str = Field(description="Valor elegido o texto escrito por el usuario")
    apply: Literal["table", "column", "foreign_key", "index", "key"] = "table"
    target: str = Field(default="", description="Código del objeto a modificar")
    column_ref: str | None = None


class ScanResult(BaseModel):
    """Respuesta de un escaneo: lo detectado mas lo que falta por preguntar."""

    model: DataModel
    questions: list[Question] = Field(default_factory=list)
    raw_ocr: str = ""
    elapsed_seconds: float = 0.0
    warnings: list[str] = Field(default_factory=list)


class ExtractionEnvelope(BaseModel):
    """Lo que se le pide al LLM que devuelva.

    Se separa del `DataModel` a proposito: el LLM devuelve un subconjunto
    dudoso y con confianza baja, y es el merge quien decide que parte entra.
    """

    tables: list[Table] = Field(default_factory=list)
    foreign_keys: list[ForeignKey] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    raw: dict[str, Any] | None = Field(
        default=None, description="Respuesta cruda del LLM, para depurar"
    )
