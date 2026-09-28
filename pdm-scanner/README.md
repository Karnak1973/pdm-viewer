# PDM Scanner

Convierte **fotos de un diagrama de modelo de datos** en un `.pdm` que abre
PowerDesigner, preguntándote lo que no se puede leer en vez de inventándolo.

```
[Móvil: cámara] --foto--> [PC: FastAPI] --OCR--> [texto + coordenadas]
                                        --LLM local--> [modelo JSON]
                             ^                                  |
                             |---- preguntas y respuestas -------|
                                                                |
                                                          [.pdm]
```

**Nada sale del equipo.** No hay nube en ninguna parte: el OCR, el modelo de
lenguaje y la generación del `.pdm` se ejecutan en el PC. El móvil solo hace
la foto, envía el fichero al PC por la wifi de casa y te enseña las
preguntas.

---

## Por qué esta herramienta existe

Un `.pdm` es un formato propietario y no se puede escribir desde cero con
confianza. Lo que hace este proyecto es **clonar la estructura de un `.pdm`
real** y sustituir los datos, conservando todos los elementos que
PowerDesigner necesita y que no están documentados.

Y el otro problema: un diagrama fotografiado nunca se lee entero. La clave
primaria puede no estar escrita, el `ON DELETE` no aparece nunca, los tipos
vienen sin longitud. Aquí **no se inventa nada**: lo dudoso se marca como
`pending` y sale convertido en pregunta.

---

## Estructura

```
pdm-scanner/
├── server/                  Python + FastAPI (se ejecuta en el PC)
│   ├── app/
│   │   ├── schema.py        Esquema JSON del modelo (contrato con el LLM)
│   │   ├── ocr.py           Preprocesado + OCR (Paddle o Tesseract)
│   │   ├── llm.py           Cliente de Ollama y prompt de extracción
│   │   ├── merge.py         Fusión incremental entre fotos
│   │   ├── questions.py     Preguntas adaptativas
│   │   ├── store.py         Persistencia en SQLite
│   │   ├── main.py          API HTTP
│   │   └── pdm/
│   │       ├── template.pdm Plantilla real de PowerDesigner 16.6
│   │       ├── generator.py Generación del .pdm
│   │       └── parse.py     Lectura, para validar el ciclo completo
│   └── tests/               61 pruebas, todas pasan sin GPU ni Ollama
├── app/                     Flutter (el móvil)
│   └── lib/
│       ├── api.dart         Cliente HTTP con errores accionables
│       ├── models.dart      Modelos Dart (espejo de schema.py)
│       ├── state.dart       Estado de la app
│       └── screens/         home, preguntas, revisión
└── docs/
    └── formato-pdm.md       Notas del formato .pdm, para quien lo toque
```

---

## Puesta en marcha

### 1. El servidor (en el PC)

```bash
cd pdm-scanner/server

python -m venv .venv
.venv\Scripts\activate          # en Windows
pip install -r requirements.txt

# OCR. Elige uno:
winget install UB-Mannheim.TesseractOCR     # fácil, menos bueno
pip install paddleocr paddlepaddle           # mejor con diagramas, más pesado

# LLM local
winget install Ollama.Ollama                # o descarga ollama.com
ollama pull qwen2.5-coder:3b                # ver "Qué modelo elegir"

python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` es necesario: con `127.0.0.1` el móvil no llega.

Comprueba que todo está en su sitio:

```bash
curl http://127.0.0.1:8000/health
```

Debe decir `"ocr": {"disponible": true}` y `"llm": {"disponible": true}`.
Si alguno sale en `false`, el `detalle` te dice exactamente qué instalar.
La app lee ese mismo endpoint al arrancar y te avisa antes de que intentes
escanear.

### 2. La app (en el móvil)

```bash
cd pdm-scanner/app
flutter pub get
flutter run
```

Necesitas un móvil Android o un emulador. En la primera pantalla escribe la
IP del PC: la tienes con `ipconfig` (busca *Dirección IPv4*), algo como
`http://192.168.1.40:8000`.

> Flutter no estaba instalado en la máquina donde se escribió esto, así que
> **el código Dart no se ha compilado todavía**. El servidor sí está probado
> con 61 tests. Ver "Qué falta" más abajo.

---

## Qué modelo elegir

El tiempo de respuesta lo manda la **memoria de vídeo**, no el modelo. Medido
aquí, con la foto de prueba en el portátil (GTX 1650 de 4 GB,
Ryzen 7 4800H):

| Modelo | Reparto | Tiempo | Aciertos |
| --- | --- | --- | --- |
| `qwen2.5-coder:7b` | 58% CPU / 42% GPU | **136 s** | más exacto: nulabilidad y longitudes bien |
| `qwen2.5-coder:3b` | cabe en la VRAM | **31 s** | se equivoca más, pero las preguntas lo cazan |

Un 7B no entra en una GPU de 4 GB y se va a CPU, y ahí la generación cae a
unos 2 tokens por segundo.

**Con GPU de 4 GB, usa el 3B.** Cumple el criterio de 30 segundos. Y hay un
detalle que importa: el 3B se equivoca más (se saltó una longitud y se inventó
una nulabilidad), pero el motor de preguntas detectó el fallo y preguntó por
ello en vez de escribir un `.pdm` con el error dentro. Ese es el comportamiento
que buscábamos, no que el modelo acierte siempre:

```
? [column_type] ¿De qué tamaño es Cliente.CLI_NOMBRE (aparece como VARCHAR2
                sin longitud)?  opciones: VARCHAR2(50), VARCHAR2(100), ...
```

Con más de 8 GB de VRAM, el 7B va holgado y conviene usarlo.

---

## Cómo funciona por dentro

### El formato `.pdm`

Inspeccionando un `.pdm` real de PowerDesigner 16.6, esto es lo que hay que
escribir bien:

| Nodo | Elementos que importan |
| --- | --- |
| `o:Table` | `a:ObjectID` (GUID), `a:Name`, `a:Code`, `c:Columns`, `c:Keys`, `c:Indexes`, `c:Owner`, `c:PrimaryKey` |
| `o:Column` | `a:Code`, `a:DataType`, `a:Length`, `a:Column.Mandatory` (solo si es NOT NULL) |
| `o:Key` | `c:Key.Columns` → `o:Column Ref` |
| `o:Index` | `a:Unique`, `c:IndexColumns` → `a:IndexColumn.Expression` |
| `o:Reference` | `a:Cardinality`, `a:DeleteConstraint`, `c:ParentTable`, `c:ChildTable`, **`c:ParentKey`**, `c:Joins` → `o:ReferenceJoin` |

Dos detalles que rompen el fichero si se ignoran, y que están cubiertos por
pruebas:

1. **La FK no referencia columnas del padre, sino su clave** (`c:ParentKey` →
   `o:Key`). Si la tabla padre no tiene ninguna `o:Key`, la relación no abre
   en PowerDesigner aunque las columnas coincidan. El generador avisa y omite
   la relación en vez de emitir un fichero que se abriría a medias.
2. **La instrucción `<?PowerDesigner ...?>` vive antes del elemento raíz**, así
   que `ElementTree.tostring(root)` no la emite. Sin ella PowerDesigner no
   identifica el fichero. El generador copia el preámbulo aparte.

### El generador: clonar, no inventar

En vez de construir el XML desde cero, cada nodo se crea como copia de un
nodo real de `template.pdm` del que se sustituyen los datos. Así se heredan
`a:PackageOptionsText`, `a:DisplayPreferences`, `a:FontList` y compañía, que
son bloques enormes de preferencias que nadie ha documentado.

Un aviso que costó una tarde: en el `.pdm` conviven **definiciones**
(`<o:Table Id="o9">`) y **referencias** al mismo tipo (`<o:Table Ref="o9"/>`),
y las referencias salen antes en el documento. Copiar una referencia como
plantilla deja el `Ref` pegado al nodo generado y, además, sin `c:Owner`, que
PowerDesigner necesita. `_blueprint()` exige el atributo `Id`.

### El ciclo de pruebas

`generator.py` genera y `parse.py` relee. El test de ida y vuelta comprueba
que lo que sale coincide con lo que entró, incluidas las PK compuestas y las
FK multip-columna. Es el fallo más común (una FK que apunta a columnas en
vez de a la clave) y el que PowerDesigner descarta en silencio.

### Preguntar en vez de inventar

`questions.py` recorre el modelo y genera preguntas por comprobación
concreta, cada una con sus opciones ya calculadas y su motivo:

- Tabla sin clave primaria → propone la convención (`CLIENTE_ID`) **pero la
  marca como `pending`**, así que sale pregunta.
- `VARCHAR2` sin longitud → inválido en Oracle, se pregunta el tamaño.
- Nulabilidad no indicada → cambia el DDL, se pregunta.
- Relación no confirmada → se pregunta cardinalidad y `ON DELETE`.
- FK cuya tabla padre todavía no se ha fotografiado → se avisa en vez de
  aceptarla a medias.

Lo confirmado por el usuario queda **blindado**: el merge nunca lo pisa. Si
una foto posterior lo contradice, se genera un conflicto y se mantiene el
valor confirmado.

---

## API

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/health` | Qué hay instalado (OCR y LLM) |
| `POST` | `/models` | Crea un modelo |
| `GET` | `/models/{id}` | Modelo + preguntas pendientes + % confirmado |
| `POST` | `/models/{id}/scan` | Foto → OCR → LLM → merge → preguntas |
| `GET` | `/models/{id}/questions` | Solo las preguntas |
| `POST` | `/models/{id}/answers` | Aplica respuestas y marca lo confirmado |
| `GET` | `/models/{id}/export.pdm` | Descarga el `.pdm` |
| `GET` | `/models/{id}/export.sql` | DDL Oracle, para tener una vista rápida |

Los avisos del generador viajan en la cabecera `X-PDM-Warnings`, porque el
`.pdm` tiene que ser un XML válido y no admite comentarios sueltos.

Documentación interactiva: <http://127.0.0.1:8000/docs>

---

## Tests

```bash
cd pdm-scanner/server
python -m pytest tests/ -q
```

88 pruebas, y ninguna necesita GPU, ni Ollama, ni un modelo descargado: el
OCR y el LLM se sustituyen por dobles. Cubren el ciclo completo del `.pdm`,
las reglas del merge, la generación de preguntas y el contrato HTTP.

---

## Qué falta y qué está verificado

Honestamente, porque importa para decidir el siguiente paso:

| Parte | Estado |
| --- | --- |
| Esquema JSON y validación | Verificado (88 tests) |
| Generación de `.pdm` con ida y vuelta | Verificado, con un `.pdm` real como plantilla |
| Merge incremental y conflictos | Verificado |
| Preguntas adaptativas | Verificado |
| API HTTP | Verificado, servidor arrancado y probado a mano |
| **OCR con Tesseract** | **Probado con foto real**: 31 fragmentos, 12/13 identificadores |
| **Pipeline completo (foto → .pdm)** | **Probado de extremo a extremo**, con OCR y LLM reales |
| App Flutter | **Sin compilar**: no hay Flutter en la máquina |
| Abrir el `.pdm` en PowerDesigner | **Sin verificar**: no hay PowerDesigner aquí |

Sobre la última fila, que es la que decide si esto sirve, se ha hecho todo lo
demás. El `.pdm` generado se ha auditado de dos formas independientes:

**1. Frente al `.pdm` real, elemento a elemento** (`tools/auditar_pdm.py`).
Se compara la firma de cada tipo de objeto (qué hijos y qué atributos lleva)
con la del `template.pmd`, que es un fichero real de PowerDesigner. Si al
generar se dejara de escribir algo que el formato trae, salta aunque el XML
sea perfectamente válido. Resultado: *todo correcto*, sin referencias
colgantes, sin ids repetidos, cabecera completa.

**2. Con el parser de la app web**, que es TypeScript, vive en otro lenguaje
y se escribió aparte contra `.pdm` reales. Si un lector independiente ve lo
mismo que el generador, es muy improbable que el error esté en el formato y no
en una lectura compartida.

```bash
python tools/auditar_pdm.py salida.pdm
npx vite-node pdm-scanner/server/tools/leer_con_el_visor.ts salida.pdm
```

```
CLIENTE (Cliente)
  PK: (CLI_ID, CLI_OFICIO, CLI_NIF) -> PK_CLIENTE
  IDX IX_CLIENTE_NIF (CLI_NIF) unique=true
PEDIDO (Pedido)
  PK: (PED_ID) -> PK_PEDIDO
  IDX IX_PEDIDO_FECHA (PED_FECHA) unique=false
LINEA_PEDIDO (Linea)
  PK: (LIN_PED_ID, LIN_NUMLIN) -> PK_LINEA

FK FK_PEDIDO_CLIENTE: PEDIDO(PED_CLI_ID, PED_CLI_OFICIO, PED_CLI_NIF) -> CLIENTE(CLI_ID, CLI_OFICIO, CLI_NIF)
FK FK_LINEA_PEDIDO: LINEA_PEDIDO(LIN_PED_ID) -> PEDIDO(PED_ID)
```

La **FK compuesta de tres columnas** es el caso difícil y se reconstruye bien:
tres `ReferenceJoin`, la clave del padre y el orden de columnas intacto.

**3. Reconstruyendo el `.pdm` real** (`tests/test_fidelidad_pdm.py`). La más
dura de las tres: se lee `template.pmd` —que es un fichero auténtico de
PowerDesigner—, se reconstruye con el generador y se vuelve a leer. El modelo
que sale a la segunda vuelta es **idéntico** al de la primera: mismas tablas,
mismas columnas en el mismo orden, misma PK, mismo índice, y la
`Reference_1` del real vuelve con sus columnas en su sitio.

Eso no demuestra que PowerDesigner acepte el fichero, pero descarta algo
distinto e igualmente importante: que entre el formato de entrada y el de
salida haya pérdidas. Si un día un `.pdm` generado se descarta al abrirlo, el
culpable no será el generador.

Y esta prueba ya ha encontrado un bug real: el parser se confundía con un
`<o:Reference Ref="o8"/>` que hay en el fichero real (el símbolo de la
relación en el diagrama) y avisaba de una "referencia incompleta" que no
existía. Es el mismo tipo de error que el de `_blueprint` en el generador —
referencias y definiciones conviven en el mismo XML, y las referencias salen
antes —, pero en el otro lado. **Solo aparecía leyendo un `.pdm` auténtico.**

También se han puesto al día los atributos de la cabecera que describen al
modelo: `Name` (que decía `example` mientras el modelo se llamaba `Banco`),
`ID` y `LastModificationDate`. El `ID` tiene que coincidir con el
`<a:ObjectID>` de `o:Model`, así que se regeneran los dos a la vez: un modelo
nuevo no debe reclamar la identidad del que le sirve de plantilla. Los
recuentos `Objects` y `Symbols` **no se tocan**: la plantilla dice
`Objects="81"` con 22 nodos con `Id`, así que son contabilidad interna de
PowerDesigner y recalcularlos con una cuenta propia sería inventar.

```bash
cd pdm-scanner/server
python -m pytest tests/test_fidelidad_pdm.py -q
```

Todo eso está en la suite, así que una regresión de formato salta al
ejecutar los tests y no al abrir el fichero en PowerDesigner dentro de seis
meses. Aun así **el paso que queda es abrirlo en PowerDesigner**: es la
única prueba que de verdad valida el formato, porque PowerDesigner puede
descartar en silencio cosas que un XML válido no delata.

El pipeline completo es `tools/pipeline_completo.py`. Con la foto de prueba
genera un `.pdm` de 53 kB que se relee sin problemas, con las dos tablas, sus
claves primarias y la FK.

Un fallo del OCR que se propaga hasta el `.pdm`: la `_` se lee como `L`
(`CLI_NOMBRE` → `CLI_LNOMBRE`). El LLM no lo corrige porque el texto es lo que
hay. Se ve en la vista de revisión y se corrige desde ahí, pero conviene
saberlo: **nadie ha inventado el dato, pero el nombre sale mal escrito**.

Las dos filas en rojo son las que hay que cerrar antes de llevarlo al
trabajo. Para el `.pdm`, el paso es abrir uno generado en PowerDesigner
Windows: si abre y las relaciones están, el generador está.

### Herramientas de diagnóstico

```bash
cd pdm-scanner/server

# Compara preprocesados y modos de Tesseract contra los textos que deben leerse
python tools/bench_ocr.py tools/diagrama_falso.jpg

# Pipeline completo con OCR y LLM reales
python tools/pipeline_completo.py tools/diagrama_falso.jpg qwen2.5-coder:3b

# Genera una foto de prueba con ruido, inclinación y sombra
python tools/generar_diagrama.py tools/diagrama_falso.jpg
```

`bench_ocr.py` es como se eligió el preprocesado. El resultado, sobre la foto
de prueba y 13 identificadores que deben leerse:

| Preprocesado | Leídos |
| --- | --- |
| sin tocar | 8/13 |
| + ecualización global | **0/13** |
| + CLAHE | 7/13 |
| + umbral de Otsu | 7/13 |
| **+ corrección de iluminación** | **12/13** |

Lo que se ve ahí es que lo intuitivo es contraproducente: ecualizar el
contraste y binarizar la imagen **empeoran** la lectura, porque Tesseract 5 ya
hace su propio umbral. Lo que sí funciona es dividir la imagen por una copia
muy desenfocada de sí misma, que quita la sombra y deja solo el texto. Ese
cambio fue el que pasó de 8/13 a 12/13.

---

## Límites conocidos

- **El destino del modelo es el de la plantilla** (`PostgreSQL 9.x`). Para
  Oracle hay que cambiar el DBMS una vez en PowerDesigner y volver a
  guardar; el `.xdb` de destino no se puede sintetizar.
- **La nulabilidad desconocida se convierte en NULL** al generar. El
  formato `.pdm` no tiene forma de decir "no lo sé", así que el generador
  asume lo más permisivo y lo avisa en la cabecera.
- **El OCR no endereza la foto.** Se le pasa por OpenCV (escala de grises,
  ecualización, umbral y ampliación), pero la corrección de perspectiva de un
  cuaderno en ángulo hay que hacerla de mejor forma: la mejora natural es
  sacar los detectores de contorno de OpenCV y está pendiente.
- **Una tabla vacía no es detectable.** Si el diagrama no la dibuja, no hay
  forma de saber que existe.





