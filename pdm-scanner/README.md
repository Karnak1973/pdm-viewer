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
│   └── tests/               50 pruebas, todas pasan sin GPU ni Ollama
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
> con 50 tests. Ver "Qué falta" más abajo.

---

## Qué modelo elegir

El tiempo de respuesta lo manda la **memoria de vídeo**, no el modelo. Medido
en un portátil con GTX 1650 (4 GB) y Ryzen 7 4800H:

| Modelo | Reparto | Tiempo por escaneo |
| --- | --- | --- |
| `qwen2.5-coder:7b` | 58% CPU / 42% GPU | **~120 s** |
| `qwen2.5-coder:3b` | cabe en la VRAM | **~35 s** |

Un 7B no entra en una GPU de 4 GB y se va a CPU, y ahí la generación cae a
unos 2 tokens por segundo. Si el primer escaneo tarda más de un minuto, el
problema no es el código.

Con GPU de 8 GB o más, el 7B va holgado. Con menos de 4 GB, usa el 3B.

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

50 pruebas, y ninguna necesita GPU, ni Ollama, ni un modelo descargado: el
OCR y el LLM se sustituyen por dobles. Cubren el ciclo completo del `.pdm`,
las reglas del merge, la generación de preguntas y el contrato HTTP.

---

## Qué falta y qué está verificado

Honestamente, porque importa para decidir el siguiente paso:

| Parte | Estado |
| --- | --- |
| Esquema JSON y validación | Verificado (50 tests) |
| Generación de `.pdm` con ida y vuelta | Verificado, con un `.pdm` real como plantilla |
| Merge incremental y conflictos | Verificado |
| Preguntas adaptativas | Verificado |
| API HTTP | Verificado, servidor arrancado y probado a mano |
| Cliente de Ollama y prompt | **Probado contra `qwen2.5-coder:7b` real**: extrae bien las tablas, tipos, longitudes, nulabilidad y la FK |
| OCR | Código escrito, **sin probar**: no hay ni Paddle ni Tesseract instalados |
| App Flutter | **Sin compilar**: no hay Flutter en la máquina |
| Abrir el `.pdm` en PowerDesigner | **Sin verificar**: no hay PowerDesigner aquí |

Las dos filas en rojo son las que hay que cerrar antes de llevarlo al
trabajo. Para el `.pdm`, el paso es abrir uno generado en PowerDesigner
Windows: si abre y las relaciones están, el generador está.

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

