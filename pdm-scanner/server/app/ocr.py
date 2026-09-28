"""
OCR de la foto del diagrama.

Nada sale del equipo: todo aqui es OpenCV mas un motor de OCR local. La idea
es que el OCR solo es la primera capa; su texto se le pasa despues al LLM
local junto con las coordenadas, que es lo que permite reconstruir la agrupacion
en tablas (que columna pertenece a que tabla).

Dos motores soportados porque la instalacion suele ser lo que falla:
  - PaddleOCR: mejor con diagramas, devuelve caja de cada texto.
  - Tesseract: mas facil de instalar, peor con tablas.

Si no hay ninguno disponible se lanza un error claro, no una excepcion rara:
mejor un mensaje accionable que un traceback.
"""

from __future__ import annotations

import io
import logging
import shutil
import subprocess
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

# Tipos de letra tipicos en un diagrama. Con estas, Tesseract rinde mucho mejor.
Psm = {
    "AUTO": 3,
    "BLOQUE_UNIFORMED": 6,
    "LINEA": 7,
}


@dataclass
class TextBox:
    """Un trozo de texto con su posición en la foto."""

    text: str
    confidence: float
    # (x_izq, y_sup, x_der, y_inf) en pixeles de la imagen original.
    box: tuple[int, int, int, int]

    @property
    def cx(self) -> float:
        return (self.box[0] + self.box[2]) / 2

    @property
    def cy(self) -> float:
        return (self.box[1] + self.box[3]) / 2

    @property
    def height(self) -> int:
        return self.box[3] - self.box[1]

    def as_text(self) -> str:
        return self.text


@dataclass
class OcrResult:
    boxes: list[TextBox] = field(default_factory=list)
    engine: str = "ninguno"
    width: int = 0
    height: int = 0

    @property
    def text(self) -> str:
        """Texto reordenado en orden de lectura: de arriba abajo y de izquierda a derecha."""
        return "\n".join(box.text for box in self.ordered)

    @property
    def ordered(self) -> list[TextBox]:
        """Agrupa en filas (tolerancia a la altura de la linea) y ordena por x."""
        if not self.boxes:
            return []
        tolerance = max(8, int(self.height * 0.012))
        filas: list[list[TextBox]] = []
        for box in sorted(self.boxes, key=lambda b: b.cy):
            for fila in filas:
                referencia = fila[0].cy
                if abs(referencia - box.cy) <= tolerance:
                    fila.append(box)
                    break
            else:
                filas.append([box])
        ordenadas: list[TextBox] = []
        for fila in filas:
            ordenadas.extend(sorted(fila, key=lambda b: b.box[0]))
        return ordenadas

    def as_prompt(self) -> str:
        """Texto con coordenadas, que es lo que necesita el LLM para agrupar.

        Sin las coordenadas el LLM lee una bolsa de palabras y no sabe que
        "CLI_NIF" cuelga de la tabla CLIENTE y no de PEDIDO.
        """
        lineas = []
        for index, box in enumerate(self.ordered):
            x1, y1, x2, y2 = box.box
            lineas.append(f"[{index}] ({x1},{y1})-({x2},{y2}) conf={box.confidence:.0f} :: {box.text}")
        return "\n".join(lineas)


class OcrNotAvailable(RuntimeError):
    """No hay ningun motor de OCR instalado."""


def preprocess(image_bytes: bytes) -> bytes:
    """Endereza, pasa a gris, mejora contraste y normaliza el tamaño.

    Las fotos de móvil llegan con la tabla en perspectiva y con sombras; sin
    esto el OCR lee menos de la mitad. Si OpenCV no está, se devuelve la
    imagen tal cual para que el flujo siga funcionando.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        log.warning("OpenCV no instalado: se usa la imagen sin preprocesar")
        return image_bytes

    buffer = np.frombuffer(image_bytes, dtype=np.uint8)
    imagen = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if imagen is None:
        raise ValueError("no se ha podido decodificar la imagen")

    # Escala de grises + ecualización: el contraste de un fondo negro sobre
    # blanco es enorme y el OCR lo agradece.
    gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)
    gris = cv2.equalizeHist(gris)

    # El texto de un diagrama es pequeño: se amplía si la imagen es pequeña.
    altura = gris.shape[0]
    if altura < 1200:
        factor = 1200 / altura
        gris = cv2.resize(gris, None, fx=factor, fy=factor, interpolation=cv2.INTER_CUBIC)

    _, binaria = cv2.threshold(gris, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    ok, codificada = cv2.imencode(".png", binaria)
    if not ok:
        return image_bytes
    return codificada.tobytes()


def _paddle(image_bytes: bytes) -> OcrResult:
    from paddleocr import PaddleOCR  # type: ignore[import-not-found]

    import numpy as np

    # API 2.x y 3.x cambian los parametros; se intenta la forma nueva y se
    # cae a la antigua en vez de romper.
    try:
        ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
        resultado = ocr.ocr(image_bytes, cls=True)
    except TypeError:
        ocr = PaddleOCR(use_angle_cls=True, lang="en")
        resultado = ocr.ocr(image_bytes, cls=True)

    boxes: list[TextBox] = []
    lineas = resultado[0] if resultado and isinstance(resultado[0], list) else []
    for linea in lineas or []:
        try:
            quadrilateral, (texto, confianza) = linea[0], linea[1]
        except (IndexError, TypeError):
            continue
        if not texto or confianza < 0.3:
            continue
        puntos = [tuple(map(int, punto)) for punto in quadrilateral]
        x1 = min(p[0] for p in puntos)
        y1 = min(p[1] for p in puntos)
        x2 = max(p[0] for p in puntos)
        y2 = max(p[1] for p in puntos)
        boxes.append(TextBox(text=str(texto), confidence=float(confianza), box=(x1, y1, x2, y2)))

    return OcrResult(boxes=boxes, engine="paddleocr")


def _tesseract(image_bytes: bytes, psm: str = "AUTO") -> OcrResult:
    import pytesseract  # type: ignore[import-not-found]
    from PIL import Image

    if shutil.which("tesseract") is None and not _tesseract_configured():
        raise OcrNotAvailable("tesseract no esta en el PATH")

    imagen = Image.open(io.BytesIO(image_bytes))
    datos = pytesseract.image_to_data(
        imagen, lang="eng", config=f"--psm {Psm.get(psm, 3)}", output_type=pytesseract.Output.DICT
    )

    boxes: list[TextBox] = []
    for indice, texto in enumerate(datos["text"]):
        limpio = (texto or "").strip()
        if not limpio:
            continue
        try:
            confianza = float(datos["conf"][indice])
        except (TypeError, ValueError):
            confianza = -1.0
        if confianza < 30:
            continue
        x, y = int(datos["left"][indice]), int(datos["top"][indice])
        w, h = int(datos["width"][indice]), int(datos["height"][indice])
        boxes.append(TextBox(text=limpio, confidence=confianza / 100.0, box=(x, y, x + w, y + h)))

    return OcrResult(boxes=boxes, engine="tesseract", width=imagen.width, height=imagen.height)


def _tesseract_configured() -> bool:
    try:
        import pytesseract  # type: ignore[import-not-found]

        pytesseract.get_tesseract_version()
        return True
    except Exception:  # noqa: BLE001 - aqui cualquier fallo significa "no disponible"
        return False


def available_engines() -> list[str]:
    motores = []
    try:
        import paddleocr  # type: ignore[import-not-found]  # noqa: F401

        motores.append("paddleocr")
    except ImportError:
        pass
    if shutil.which("tesseract") or _tesseract_configured():
        motores.append("tesseract")
    return motores


def run_ocr(image_bytes: bytes, engine: str = "auto", psm: str = "AUTO") -> OcrResult:
    """Lanza el OCR. `engine=auto` prueba Paddle y cae a Tesseract."""
    if engine == "tesseract":
        return _tesseract(image_bytes, psm)
    if engine == "paddleocr":
        return _paddle(image_bytes)

    if "paddleocr" in available_engines():
        try:
            return _paddle(image_bytes)
        except Exception as error:  # noqa: BLE001 - se informa y se prueba el otro
            log.warning("PaddleOCR falló (%s), pruebo Tesseract", error)
    if "tesseract" in available_engines():
        return _tesseract(image_bytes, psm)

    raise OcrNotAvailable(
        "no hay ningun motor de OCR. Instala uno de los dos:\n"
        "  pip install paddleocr paddlepaddle   (mejor con diagramas)\n"
        "  winget install UB-Mannheim.TesseractOCR  (mas facil)\n"
        "y despues reinicia el servidor."
    )

