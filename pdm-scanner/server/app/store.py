"""
Persistencia en SQLite.

Un solo fichero en el PC del usuario. Las fotos se guardan aparte en disco
(con su nombre original) y aqui solo queda la referencia, para poder volver a
reprocesar sin volver a hacer la foto.

No hay migraciones: si cambia el esquema, se borra el fichero. Es una app de
un solo ordenador y el coste de migrar es mayor que el de empezar de cero.
"""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .schema import DataModel, ScanResult

SCHEMA = """
CREATE TABLE IF NOT EXISTS models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    payload     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id    INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    created_at  REAL NOT NULL,
    image_path  TEXT,
    ocr_engine  TEXT,
    ocr_text    TEXT,
    payload     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_model ON scans(model_id);
"""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._conexion() as conexion:
            conexion.executescript(SCHEMA)

    @contextmanager
    def _conexion(self) -> Iterator[sqlite3.Connection]:
        conexion = sqlite3.connect(self.path)
        conexion.row_factory = sqlite3.Row
        conexion.execute("PRAGMA foreign_keys = ON")
        try:
            yield conexion
            conexion.commit()
        finally:
            conexion.close()

    # -- Modelos --------------------------------------------------------

    def create_model(self, name: str) -> DataModel:
        ahora = time.time()
        modelo = DataModel(name=name)
        with self._conexion() as conexion:
            cursor = conexion.execute(
                "INSERT INTO models (name, created_at, updated_at, payload) VALUES (?, ?, ?, ?)",
                (name, ahora, ahora, modelo.model_dump_json()),
            )
            modelo_id = int(cursor.lastrowid or 0)
        return modelo.model_copy(update={"name": name})

    def save_model(self, model_id: int, modelo: DataModel) -> None:
        with self._conexion() as conexion:
            conexion.execute(
                "UPDATE models SET name = ?, updated_at = ?, payload = ? WHERE id = ?",
                (modelo.name, time.time(), modelo.model_dump_json(), model_id),
            )

    def get_model(self, model_id: int) -> DataModel | None:
        with self._conexion() as conexion:
            fila = conexion.execute(
                "SELECT payload FROM models WHERE id = ?", (model_id,)
            ).fetchone()
        if fila is None:
            return None
        return DataModel.model_validate_json(fila["payload"])

    def latest_model(self) -> tuple[int, DataModel] | None:
        with self._conexion() as conexion:
            fila = conexion.execute(
                "SELECT id, payload FROM models ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
        if fila is None:
            return None
        return int(fila["id"]), DataModel.model_validate_json(fila["payload"])

    def list_models(self) -> list[dict]:
        with self._conexion() as conexion:
            filas = conexion.execute(
                "SELECT id, name, created_at, updated_at FROM models ORDER BY updated_at DESC"
            ).fetchall()
        return [dict(fila) for fila in filas]

    def delete_model(self, model_id: int) -> None:
        with self._conexion() as conexion:
            conexion.execute("DELETE FROM models WHERE id = ?", (model_id,))

    # -- Escaneos -------------------------------------------------------

    def save_scan(
        self,
        model_id: int,
        resultado: ScanResult,
        image_path: str | None,
        ocr_engine: str,
    ) -> int:
        with self._conexion() as conexion:
            cursor = conexion.execute(
                "INSERT INTO scans (model_id, created_at, image_path, ocr_engine, ocr_text, payload)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    model_id,
                    time.time(),
                    image_path,
                    ocr_engine,
                    resultado.raw_ocr[:200_000],
                    resultado.model.model_dump_json(),
                ),
            )
            return int(cursor.lastrowid or 0)

    def list_scans(self, model_id: int) -> list[dict]:
        with self._conexion() as conexion:
            filas = conexion.execute(
                "SELECT id, created_at, image_path, ocr_engine FROM scans"
                " WHERE model_id = ? ORDER BY created_at DESC",
                (model_id,),
            ).fetchall()
        return [dict(fila) for fila in filas]
