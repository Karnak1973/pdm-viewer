"""
Genera una imagen que imita una foto de un diagrama de modelo de datos.

Sirve para probar el pipeline completo (OCR + LLM + merge + .pdm) sin
depender de tener un diagrama real a mano. No es un test: es una herramienta
para reproducir un caso concreto, con el ruido que meten las fotos reales
(grieta, inclinacion, ruido y una sombra).
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# Tablas del "diagrama" que se quiere reconstruir.
DIAGRAMA = {
    "CLIENTE": [
        ("CLI_ID", "NUMBER(8)", "NOT NULL"),
        ("CLI_NIF", "VARCHAR2(9)", "NOT NULL"),
        ("CLI_NOMBRE", "VARCHAR2(100)", "NOT NULL"),
        ("CLI_FECHA_ALTA", "DATE", ""),
    ],
    "PEDIDO": [
        ("PED_ID", "NUMBER(8)", "NOT NULL"),
        ("PED_CLI_ID", "NUMBER(8)", "NOT NULL"),
        ("PED_FECHA", "DATE", "NOT NULL"),
        ("PED_IMPORTE", "NUMBER(12,2)", ""),
    ],
}

FUENTES = [
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\calibri.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
    r"C:\Windows\Fonts\verdana.ttf",
]


def _fuente(tamano: int) -> ImageFont.FreeTypeFont:
    for ruta in FUENTES:
        if Path(ruta).exists():
            return ImageFont.truetype(ruta, tamano)
    return ImageFont.load_default()


def dibujar(destino: Path, semilla: int = 7) -> None:
    """Pinta dos cajas de tabla y les mete los tics de una foto."""
    aleatorio = random.Random(semilla)

    ancho, alto = 1400, 900
    imagen = Image.new("RGB", (ancho, alto), (250, 250, 248))
    dibujo = ImageDraw.Draw(imagen)

    fuente_titulo = _fuente(30)
    fuente_celda = _fuente(21)
    fuente_tipo = _fuente(19)

    # La tabla padre arriba a la izquierda, la hija abajo a la derecha.
    posiciones = {"CLIENTE": (110, 110), "PEDIDO": (830, 470)}
    anchos = {"CLIENTE": 620, "PEDIDO": 460}

    for nombre, columnas in DIAGRAMA.items():
        x, y = posiciones[nombre]
        ancho_tabla = anchos[nombre]
        alto_cabecera = 46
        alto_fila = 34

        # Cuerpo de la tabla
        alto_tabla = alto_cabecera + alto_fila * len(columnas)
        dibujo.rectangle(
            [x, y, x + ancho_tabla, y + alto_tabla], fill=(255, 255, 255), outline=(20, 20, 20), width=3
        )
        # Cabecera sombreada, como en PowerDesigner
        dibujo.rectangle(
            [x, y, x + ancho_tabla, y + alto_cabecera], fill=(222, 226, 232), outline=(20, 20, 20), width=3
        )
        dibujo.text((x + 14, y + 10), nombre, font=fuente_titulo, fill=(10, 10, 10))

        for indice, (columna, tipo, restriccion) in enumerate(columnas):
            fila_y = y + alto_cabecera + indice * alto_fila
            if indice % 2 == 1:
                dibujo.rectangle(
                    [x + 3, fila_y, x + ancho_tabla - 3, fila_y + alto_fila], fill=(248, 248, 250)
                )
            dibujo.text((x + 14, fila_y + 7), columna, font=fuente_celda, fill=(15, 15, 15))
            dibujo.text((x + 250, fila_y + 8), tipo, font=fuente_tipo, fill=(70, 70, 70))
            if restriccion:
                dibujo.text((x + 440, fila_y + 8), restriccion, font=fuente_tipo, fill=(70, 70, 70))

    # La relación, con su notación de cuña
    dibujo.line([(110 + 620, 250), (830, 520)], fill=(30, 30, 30), width=3)
    dibujo.polygon([(830, 520), (806, 512), (812, 500)], fill=(30, 30, 30))
    dibujo.text((620, 300), "1:N", font=fuente_tipo, fill=(30, 30, 30))

    # Marcas de PK y FK junto a las columnas
    dibujo.text((92, 152), "PK", font=fuente_tipo, fill=(30, 30, 30))
    dibujo.text((92, 220), "PK", font=fuente_tipo, fill=(30, 30, 30))
    dibujo.text((808, 512), "FK", font=fuente_tipo, fill=(30, 30, 30))

    # --- Lo que hace que parezca una foto ---------------------------------
    # Inclinación leve, como si el móvil no estuviera recto.
    imagen = imagen.rotate(1.6, resample=Image.BICUBIC, fillcolor=(250, 250, 248), expand=False)
    # Suavizado: fuera de foco.
    imagen = imagen.filter(ImageFilter.GaussianBlur(0.6))
    # Ruido de sensor.
    pixeles = imagen.load()
    for y in range(0, alto, 2):
        for x in range(0, ancho, 2):
            ruido = aleatorio.randint(-9, 9)
            r, g, b = pixeles[x, y]
            pixeles[x, y] = (
                max(0, min(255, r + ruido)),
                max(0, min(255, g + ruido)),
                max(0, min(255, b + ruido)),
            )
    # Sombra en una esquina.
    sombra = Image.new("L", (ancho, alto), 0)
    ImageDraw.Draw(sombra).ellipse([-300, -300, 520, 520], fill=110)
    sombra = sombra.filter(ImageFilter.GaussianBlur(90))
    imagen = Image.composite(Image.new("RGB", (ancho, alto), (120, 120, 125)), imagen, sombra)

    # Compresión de JPEG, como una foto de móvil.
    imagen.save(destino, "JPEG", quality=78)
    print(f"escrita {destino} ({destino.stat().st_size // 1024} kB, {imagen.width}x{imagen.height})")


if __name__ == "__main__":
    salida = Path(sys.argv[1] if len(sys.argv) > 1 else "diagrama_falso.jpg")
    dibujar(salida)

