"""
Banco de pruebas del OCR.

Compara preprocesados y modos de segmentación de Tesseract contra una lista
de textos que *deben* leerse. Contar palabras no dice nada: Tesseract puede
devolver 60 palabras y ninguna útil. Lo que se mide es cuántos de los
identificadores del diagrama aparecen.

    python tools/bench_ocr.py imagen.jpg
"""

from __future__ import annotations

import io
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2  # noqa: E402
import pytesseract  # noqa: E402

from app import ocr  # noqa: E402

# Lo que tiene que leerse del diagrama que genera generar_diagrama.py.
ESPERADOS = [
    "CLIENTE",
    "CLI_ID",
    "CLI_NIF",
    "CLI_NOMBRE",
    "CLI_FECHA_ALTA",
    "PEDIDO",
    "PED_ID",
    "PED_CLI_ID",
    "PED_FECHA",
    "PED_IMPORTE",
    "NUMBER",
    "VARCHAR2",
    "DATE",
]


def _gris(datos: bytes) -> np.ndarray:
    imagen = cv2.imdecode(np.frombuffer(datos, dtype=np.uint8), cv2.IMREAD_COLOR)
    return cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)


def preprocesados(original: bytes) -> dict[str, bytes]:
    """Variantes a comparar. Se prueban a propósito para elegir con datos."""
    gris = _gris(original)
    variantes: dict[str, bytes] = {"sin tocar": original}

    def codificar(matriz: np.ndarray) -> bytes:
        ok, buffer = cv2.imencode(".png", matriz)
        return buffer.tobytes() if ok else original

    mediana = cv2.medianBlur(gris, 3)
    variantes["mediana"] = codificar(mediana)

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    variantes["mediana+clahe"] = codificar(clahe.apply(mediana))

    # Ampliar es lo que más ayuda: el texto de una tabla son pocos píxeles.
    grande = cv2.resize(clahe.apply(mediana), None, fx=1.6, fy=1.6, interpolation=cv2.INTER_CUBIC)
    variantes["mediana+clahe x1.6"] = codificar(grande)

    binaria = cv2.threshold(mediana, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    variantes["mediana+otsu"] = codificar(binaria)

    # La corrección de iluminación es lo que arregla las sombras: se divide la
    # imagen por una versión muy desenfocada de sí misma, y queda solo el texto.
    # Es la técnica clásica de escaneo de documentos y la que puede recuperar
    # las tablas que caen en la zona en penumbra.
    fondo = cv2.GaussianBlur(gris, (0, 0), sigmaX=25)
    plano = cv2.divide(gris, fondo, scale=255)
    variantes["sin-iluminacion"] = codificar(plano)

    plano_nitido = cv2.divide(cv2.medianBlur(gris, 3), cv2.GaussianBlur(gris, (0, 0), 25), scale=255)
    plano_nitido = cv2.resize(plano_nitido, None, fx=1.6, fy=1.6, interpolation=cv2.INTER_CUBIC)
    variantes["sin-iluminacion x1.6"] = codificar(plano_nitido)

    return variantes


def medir(datos: bytes, psm: int) -> tuple[int, float, str]:
    inicio = time.time()
    imagen = Image.open(io.BytesIO(datos))
    texto = pytesseract.image_to_string(imagen, lang="eng", config=f"--psm {psm}")
    normalizado = " ".join(texto.upper().split())
    encontrados = sum(1 for esperado in ESPERADOS if esperado in normalizado)
    return encontrados, time.time() - inicio, normalizado


def main(ruta: str) -> int:
    ocr._configurar_tesseract()
    original = Path(ruta).read_bytes()

    print(f"imagen: {ruta} ({len(original) // 1024} kB)")
    print(f"textos que deben leerse: {len(ESPERADOS)}\n")
    print(f"{'preprocesado':22} {'psm':>4} {'lee':>5} {'segs':>6}   missed")

    mejor = (-1, "", 0)
    for nombre, datos in preprocesados(original).items():
        for psm in (3, 4, 6, 11, 12):
            encontrados, segundos, texto = medir(datos, psm)
            faltan = [e for e in ESPERADOS if e not in texto]
            marca = ""
            if encontrados > mejor[0]:
                mejor = (encontrados, nombre, psm)
                marca = "  <-- mejor"
            print(f"{nombre:22} {psm:>4} {encontrados:>5} {segundos:>5.1f}s   {', '.join(faltan)[:44]}{marca}")

    print(f"\nMEJOR: {mejor[0]}/{len(ESPERADOS)} con '{mejor[1]}' y --psm {mejor[2]}")
    return mejor[0]


if __name__ == "__main__":
    imagen = sys.argv[1] if len(sys.argv) > 1 else str(
        Path(__file__).with_name("diagrama_falso.jpg")
    )
    sys.exit(0 if main(imagen) >= 8 else 1)
