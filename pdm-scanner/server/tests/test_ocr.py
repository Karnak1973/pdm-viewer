"""
Pruebas del OCR que no dependen de tener Tesseract instalado.

El caso que motivó estas pruebas: el preprocesado hacía `equalizeHist` global
más un umbral de Otsu, y con una foto con ruido **la imagen salía casi negra**
y el OCR no leía nada. Ese fallo no se ve en el código, se ve mirando la
imagen, y sale justo al probarlo con una foto real.

Aquí se comprueba lo que se puede comprobar sin motores instalados: que el
preprocesado devuelve una imagen con contraste utilizable y que el reintento
con la original funciona. El resto se midió con `tools/bench_ocr.py`.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.ocr import (
    OcrNotAvailable,
    OcrResult,
    TextBox,
    _con_reintento,
    preprocess,
    run_ocr,
)

PIL = pytest.importorskip("PIL", reason="Pillow es necesario para las pruebas de imagen")
cv2 = pytest.importorskip("cv2", reason="OpenCV es necesario para las pruebas de preprocesado")


def imagen_con_texto(ruido: int = 0, sombra: bool = True) -> bytes:
    """Dibuja trazos finos y oscuros como los del texto de un diagrama.

    Importante que sean **líneas finas y no un bloque macizo**: un rectángulo
    oscuro grande es indistinguible de una zona en penumbra, y la corrección de
    iluminación lo normaliza a blanco (que es justo lo que debe hacer). El
    texto real son trazos sobre fondo localmente claro, que es lo que sí debe
    sobrevivir.

    Se hace de 1100x1400: por debajo de 1000 px de alto el preprocesado amplía
    la imagen y las coordenadas de estos tests dejan de apuntar a lo que dicen.
    """
    alto, ancho = 1100, 1400
    imagen = np.full((alto, ancho), 235, dtype=np.uint8)

    # "Tarjeta" clara con diez renglones de texto: barras finas y oscuras.
    for indice in range(10):
        y = 420 + indice * 30
        largo = 700 if indice % 2 == 0 else 520
        imagen[y : y + 12, 200 : 200 + largo] = 25
    # Segunda tarjeta, para tener dos bloques como en un diagrama.
    for indice in range(5):
        y = 830 + indice * 30
        imagen[y : y + 12, 200 : 200 + 600] = 25

    if sombra:
        # Cuadrante superior izquierdo en penumbra, como una foto real.
        imagen[:550, :700] = (imagen[:550, :700] * 0.55).astype(np.uint8)

    if ruido:
        generador = np.random.default_rng(42)
        imagen = np.clip(
            imagen.astype(int) + generador.integers(-ruido, ruido, imagen.shape), 0, 255
        ).astype(np.uint8)

    ok, buffer = cv2.imencode(".png", imagen)
    assert ok
    return buffer.tobytes()


def _abrir(datos: bytes) -> np.ndarray:
    matriz = cv2.imdecode(np.frombuffer(datos, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    assert matriz is not None
    return matriz


# --------------------------------------------------------------------------
# Preprocesado
# --------------------------------------------------------------------------


def test_el_preprocesado_conserva_el_contraste() -> None:
    """Lo que fallaba: la imagen salía casi negra y no había texto legible."""
    procesada = _abrir(preprocess(imagen_con_texto(ruido=10)))
    assert procesada.shape[0] == 1100
    assert procesada.max() - procesada.min() > 100, "la imagen se ha aplanado"


def test_el_preprocesado_no_invierte_el_texto_al_fondo() -> None:
    """El texto oscuro sobre fondo claro debe seguir siendo mucho más oscuro."""
    procesada = _abrir(preprocess(imagen_con_texto()))
    # Dentro de un renglón (fila 420..432) frente al hueco entre renglones.
    texto = procesada[422:430, 250:850]
    fondo = procesada[437:448, 250:850]
    assert texto.mean() < fondo.mean() - 80, "el texto y el fondo se han igualado"


def test_la_correccion_de_iluminacion_aclara_la_sombra() -> None:
    """Es lo que recupera las tablas que caen en la zona en penumbra.

    En la foto de prueba esto pasó de 8/13 identificadores leídos a 12/13.
    """
    procesada = _abrir(preprocess(imagen_con_texto(sombra=True)))
    # La misma zona, en sombra antes y con luz después.
    con_sombra = _abrir(imagen_con_texto(sombra=True))
    antes = con_sombra[60:300, 60:660].mean()
    despues = procesada[60:300, 60:660].mean()
    assert despues > antes, "la zona en sombra no se ha aclarado"


def test_una_foto_muy_pequena_se_amplia() -> None:
    """Hasta 3x. El tope existe porque ampliar de más no aporta y cuesta."""
    matriz = np.full((300, 400), 240, dtype=np.uint8)
    matriz[100:200, 50:350] = 15
    ok, buffer = cv2.imencode(".png", matriz)
    assert ok
    assert _abrir(preprocess(buffer.tobytes())).shape[0] == 900


def test_una_foto_ya_grande_no_se_amplia() -> None:
    matriz = np.full((1400, 1800), 240, dtype=np.uint8)
    ok, buffer = cv2.imencode(".png", matriz)
    assert ok
    assert _abrir(preprocess(buffer.tobytes())).shape[0] == 1400


def test_una_imagen_ilegible_da_error_claro() -> None:
    with pytest.raises(ValueError, match="decodificar"):
        preprocess(b"esto no es una imagen")


# --------------------------------------------------------------------------
# Reintento
# --------------------------------------------------------------------------


def test_si_el_preprocesado_no_lee_nada_se_reintenta_con_la_original() -> None:
    """Mejor una foto peor leída que un escaneo vacío sin explicación."""
    original = imagen_con_texto()
    vistos: list[bytes] = []

    def motor(datos: bytes) -> OcrResult:
        vistos.append(datos)
        if datos == preprocess(original):
            return OcrResult(boxes=[], engine="doble")  # el preprocesado falla
        return OcrResult(boxes=[TextBox("CLI_ID", 0.9, (0, 0, 1, 1))], engine="doble")

    resultado = _con_reintento(original, motor, binarizar=False)

    assert len(vistos) == 2, "debería haber intentado las dos veces"
    assert resultado.boxes, "el reintento con la original debería haber leído algo"


def test_si_el_preprocesado_va_bien_no_se_reintenta() -> None:
    original = imagen_con_texto()
    llamadas = 0

    def motor(datos: bytes) -> OcrResult:
        nonlocal llamadas
        llamadas += 1
        return OcrResult(boxes=[TextBox("X", 0.9, (0, 0, 1, 1))], engine="doble")

    _con_reintento(original, motor, binarizar=False)
    assert llamadas == 1


# --------------------------------------------------------------------------
# Lectura del texto
# --------------------------------------------------------------------------


def test_el_orden_de_lectura_reconstruye_las_filas() -> None:
    """Lo que ve el LLM: si las columnas no caen en su fila, no hay tabla.

    Se meten las cajas desordenadas a propósito, como las devuelve el OCR.
    """
    resultado = OcrResult(
        boxes=[
            TextBox("PED_FECHA", 0.9, (300, 200, 400, 220)),
            TextBox("PED_ID", 0.9, (100, 100, 200, 120)),
            TextBox("NUMBER(8)", 0.9, (500, 100, 700, 120)),
            TextBox("DATE", 0.9, (500, 200, 600, 220)),
        ],
        width=1000,
        height=500,
    )

    lineas = [box.text for box in resultado.ordered]
    assert lineas == ["PED_ID", "NUMBER(8)", "PED_FECHA", "DATE"]


def test_el_prompt_incluye_las_coordenadas() -> None:
    """Sin coordenadas el LLM no sabe a qué tabla pertenece cada columna."""
    resultado = OcrResult(
        boxes=[TextBox("CLI_ID", 0.93, (110, 90, 220, 110))], width=800, height=600
    )
    prompt = resultado.as_prompt()
    assert "CLI_ID" in prompt
    assert "(110,90)-(220,110)" in prompt
    assert "conf=" in prompt


# --------------------------------------------------------------------------
# Motor ausente
# --------------------------------------------------------------------------


def test_sin_motores_el_error_dice_que_instalar() -> None:
    import app.ocr as ocr_modulo

    original = ocr_modulo.available_engines
    ocr_modulo.available_engines = lambda: []
    try:
        with pytest.raises(OcrNotAvailable) as error:
            run_ocr(imagen_con_texto())
        # El mensaje tiene que ser accionable, no un traceback.
        assert "winget" in str(error.value) or "pip install" in str(error.value)
    finally:
        ocr_modulo.available_engines = original
