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
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

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


def preprocess(image_bytes: bytes, binarize: bool = False) -> bytes:
    """Prepara la foto para que el OCR lea el texto del diagrama.

    La receta está **medida**, no supuesta. Con la foto de prueba de
    `tools/bench_ocr.py` (1400x900, inclinada, con ruido de sensor, una sombra
    en la esquina y compresión JPEG) sobre Tesseract 5.4, de 13 identificadores
    que deben leerse:

        imagen sin tocar ............  8/13
        + ecualización global .......  0/13   <- empeora mucho
        + CLAHE .....................  7/13
        + umbral de Otsu ............  7/13
        + corrección de iluminación  12/13   <- la que vale

    La corrección de iluminación es la clave: se divide la imagen por una
    versión muy desenfocada de sí misma y queda solo el texto, sin la sombra.
    Sin ella, las tablas que caen en la zona en penumbra desaparecen.

    Lo que **no** se hace, pese a lo intuitivo: ecualizar el contraste global
    y binarizar. Tesseract 5 hace su propio umbral interno y adelantarse le
    quita información. `binarize=True` se deja para PaddleOCR.

    Si OpenCV no está, se devuelve la imagen tal cual y el flujo sigue.
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
        raise ValueError("no se he podido decodificar la imagen")

    gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)

    # 1. Ruido de sensor. Antes de la iluminación, no después: el ruido hace
    #    que el divisor tenga picos y ensucia el resultado.
    gris = cv2.medianBlur(gris, 3)

    # 2. Corrección de iluminación. El divisor es la propia imagen muy
    #    desenfocada, así cada zona queda normalizada respecto a su fondo.
    fondo = cv2.GaussianBlur(gris, (0, 0), sigmaX=25)
    gris = cv2.divide(gris, fondo, scale=255)

    # 3. Sólo si la foto es muy pequeña. Por debajo de 1000 px de alto se
    #    pierde texto, pero ampliar no siempre compensa: con la iluminación ya
    #    corregida, ampliar no aportó nada y duplica el tiempo.
    if gris.shape[0] < 1000:
        factor = min(3.0, 1000 / gris.shape[0])
        gris = cv2.resize(gris, None, fx=factor, fy=factor, interpolation=cv2.INTER_CUBIC)

    if binarize:
        gris = cv2.threshold(gris, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]

    ok, codificada = cv2.imencode(".png", gris)
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

    _configurar_tesseract()

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
        return _find_tesseract() is not None


def _find_tesseract() -> str | None:
    """Localiza el ejecutable de Tesseract.

    No basta con mirar el PATH: tras instalar con `winget` el ejecutable queda
    en `C:\\Program Files\\Tesseract-OCR` y **no se añade al PATH** de una
    sesión ya abierta (tampoco de las siguientes, si no se reinicia el
    explorer). Buscarlo en las rutas habituales evita que el usuario tenga un
    Tesseract instalado y la app le diga que no lo tiene.
    """
    encontrado = shutil.which("tesseract")
    if encontrado:
        return encontrado

    candidatos = []
    if os.name == "nt":
        for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(variable)
            if base:
                candidatos.append(Path(base) / "Tesseract-OCR" / "tesseract.exe")
    else:
        candidatos += [Path("/usr/bin/tesseract"), Path("/usr/local/bin/tesseract")]

    for candidato in candidatos:
        if candidato.exists():
            return str(candidato)
    return None


def _configurar_tesseract() -> str:
    """Deja `pytesseract` apuntando al ejecutable y devuelve su ruta."""
    import pytesseract  # type: ignore[import-not-found]

    ruta = _find_tesseract()
    if ruta is None:
        raise OcrNotAvailable(
            "Tesseract no está instalado.\n"
            "Instálalo con:  winget install UB-Mannheim.TesseractOCR"
        )
    pytesseract.pytesseract.tesseract_cmd = ruta
    return ruta


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
    """Lanza el OCR sobre la foto.

    `engine=auto` prueba Paddle y cae a Tesseract. Si el motor elegido no
    devuelve nada, se reintenta con la imagen **sin preprocesar**: la
    corrección de iluminación mejora mucho en las pruebas, pero en un
    diagrama muy limpio puede quedarse sin texto. Mejor una foto peor leída
    que un escaneo vacío sin explicación.
    """
    motores = available_engines()

    if engine == "tesseract":
        return _con_reintento(image_bytes, lambda d: _tesseract(d, psm), False)
    if engine == "paddleocr":
        return _con_reintento(image_bytes, _paddle, True)
    if engine == "raw":
        return _con_reintento(image_bytes, lambda d: _tesseract(d, psm), False, preprocesar=False)

    if "paddleocr" in motores:
        try:
            return _con_reintento(image_bytes, _paddle, True)
        except Exception as error:  # noqa: BLE001 - se informa y se prueba el otro
            log.warning("PaddleOCR falló (%s), pruebo Tesseract", error)
    if "tesseract" in motores:
        return _con_reintento(image_bytes, lambda d: _tesseract(d, psm), False)

    raise OcrNotAvailable(
        "no hay ningun motor de OCR. Instala uno de los dos:\n"
        "  pip install paddleocr paddlepaddle   (mejor con diagramas)\n"
        "  winget install UB-Mannheim.TesseractOCR  (mas facil)\n"
        "y despues reinicia el servidor."
    )


def _con_reintento(
    original: bytes, ejecutar, binarizar: bool, preprocesar: bool = True
) -> OcrResult:
    """Ejecuta el OCR sobre la imagen preprocesada y, si no lee nada, sobre la
    original."""
    if preprocesar:
        resultado = ejecutar(preprocess(original, binarize=binarizar))
        if resultado.boxes:
            return resultado
        log.info("El preprocesado no ha dado texto; reintento con la imagen original")

    return ejecutar(original)


