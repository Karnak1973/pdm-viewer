# PDM Viewer

Visor web para abrir archivos PowerDesigner `.pdm` y explorar el esquema de datos en una vista tipo diagrama entidad-relación.

## Características

- carga de archivos `.pdm` y `.xml`
- visualización de tablas, columnas, claves primarias, relaciones e índices
- vista de diagrama con nodos tipo entidad
- panel lateral con listados y búsqueda
- detalle de tabla con metadatos y SQL DDL
- generación de SQL compatible con Oracle
- edición de metadatos (nombres, tipos, longitud, NOT NULL, comentarios) con descarga del `.pdm`
- funcionamiento totalmente en cliente, sin backend

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
npm install
```

## Ejecutar en desarrollo

```bash
npm run dev
```

Luego abre la URL que muestre Vite, normalmente:

```bash
http://localhost:5173
```

## Compilar para producción

Este proyecto genera dos artefactos distintos e independientes:

| Comando | Salida | IA externa | Uso |
| --- | --- | --- | --- |
| `npm run build` | `dist/` | Disponible y opcional | Uso personal |
| `npm run build:offline` | `dist-offline/` | **No existe** | Equipos del trabajo sin salida a Internet |

Para previsualizar cada versión:

```bash
npm run preview          # versión normal
npm run preview:offline  # versión de trabajo, sin IA externa
```

### Qué cambia en la compilación de trabajo

- La opción de IA externa **no aparece** en la interfaz; en su lugar se muestra el
  aviso "Modo sin conexión".
- **El código de red no se incluye en la compilación.** No se empaqueta ni el
  runtime de Transformers ni el de ONNX, así que el artefacto baja de ~27 MB a
  poco más de 500 kB.
- La búsqueda semántica sigue funcionando con el motor local, que no usa la red.

Cómo funciona: `.env.offline` define `VITE_ENABLE_EXTERNAL_AI=false`, y ese valor
alimenta tres cosas a la vez desde `vite.config.ts`:

1. El flag `EXTERNAL_AI_ENABLED` (`src/ml/buildConfig.ts`), que decide qué
   muestra la barra lateral en la búsqueda semántica.
2. Un alias de resolución: el especificador `@neural` apunta a
   `src/ml/neural.ts` en la compilación normal y a `src/ml/neural.offline.ts`
   (un stub sin ninguna dependencia de red) en la compilación `offline`. Al no
   entrar en el grafo de módulos, Transformers no puede empaquetarse.
3. Un segundo alias, `@externalAiPanel`, que apunta al panel de autorización
   (`ExternalAiPanel.tsx`) o a su versión deshabilitada
   (`ExternalAiPanel.offline.tsx`, que devuelve `null`). Hace falta porque el
   panel menciona el host del que se descarga el modelo: si se quedara dentro
   del componente común, esa cadena sobreviviría al minificado y la
   auditoría de abajo daría un falso positivo.

### Cómo auditar el artefacto de trabajo

```powershell
# Solo contiene estos archivos
Get-ChildItem -Recurse dist-offline -File

# Y ninguna referencia a IA externa
Get-ChildItem -Recurse dist-offline -File |
  Select-String -Pattern 'huggingface|Xenova|onnxruntime|transformers'
```

La segunda orden no devuelve resultados, que es la garantía verificable de que la
compilación de trabajo no puede establecer conexiones de red.

Conviene buscar en **todos** los ficheros y de forma recursiva (`Get-ChildItem
-Recurse`), no solo en el directorio raíz: los scripts se emiten dentro de
`dist-offline/assets/`, así que un `Select-String -Path dist-offline\*` sobre los
ficheros sueltos de la raíz no llega a verlos.

## Uso

1. Inicia la aplicación con `npm run dev`.
2. En la pantalla principal, arrastra y suelta un archivo `.pdm` o pulsa para seleccionar uno.
3. El visor cargará el modelo y mostrará:
   - el árbol de tablas a la izquierda
   - el diagrama ER en el centro
   - el detalle de la tabla seleccionada a la derecha
4. Puedes cambiar entre las vistas de `Detalles`, `SQL` y `Modelo`.
5. Si quieres copiar el DDL generado, usa el botón `Copiar SQL`.

## Script de migración Oracle (pestaña Diff)

Cargas el `.pdm` original, vas a la pestaña **Diff** y cargas un segundo `.pdm`
con el modelo ya cambiado. Además del listado de diferencias, la vista **Migración**
genera el SQL necesario para llevar la base de datos de un modelo al otro:

| Vista | Qué muestra |
| --- | --- |
| **Impacto** | Tablas afectadas, qué cambia en cada una, sus tablas hijas, sus FKs y los índices que se rehacen |
| **Script** | El SQL ordenado, con comentarios y dos botones para copiarlo o descargarlo como `.sql` |
| **Rollback** | El script inverso, para volver al estado anterior |

### Por qué el script va ordenado

Oracle no deja modificar una columna que forma parte de una clave primaria ni de
una clave foránea, así que el orden de las fases es obligatorio:

```text
1. Prevalidación   → duplicados en la nueva PK y filas huérfanas (comentado)
2. DROP FKs        → las hijas que apuntan a las tablas que cambian
3. DROP índices    → los que cubren columnas renombradas o modificadas
4. DROP claves     → primarias y alternativas que cambian
5. Tablas          → RENAME TO, CREATE TABLE, DROP TABLE
6. Columnas        → RENAME COLUMN, MODIFY, ADD, DROP COLUMN
7. ADD claves      → la PK con su nueva lista de columnas y las UNIQUE
8. CREATE índices
9. ADD FKs         → siempre al final, ya con los nombres nuevos
10. Comentarios    → COMMENT ON TABLE / COLUMN
```

Las consultas de prevalidación vienen comentadas a propósito: descoméntalas y
ejecútalas antes de tocar nada, porque son las que avisan de que el cambio va a
fallar por datos existentes.

### Qué detecta

Cambios de clave primaria (alta, baja o cambio de columnas), renombrados de
tablas y de columnas, cambios de tipo, longitud, precisión, obligatoriedad,
default, comentarios, columnas y tablas añadidas o eliminadas, e índices y
claves modificadas. Las tablas y columnas se emparejan por su identificador
estable de PowerDesigner (`Id`), de modo que un renombrado se traduce en
`RENAME COLUMN` y no en un `DROP` más un `ADD`.
### Advertencias

- Los nombres de constraints salen del modelo (`PK_<TABLA>`, el nombre de la
  clave, el nombre de la referencia). Contrástalos con tu base de datos antes de
  ejecutar: el propio script lleva el aviso en la cabecera.
- El rollback devuelve la estructura anterior, pero **no recupera los datos**
  de las columnas o tablas que el script directo eliminó. El script lo indica
  en su cabecera cuando es el caso.
- Cambiar una columna a `IDENTITY` no se puede resolver con `ALTER TABLE`; el
  impacto lo señala como posible necesidad de recrear la tabla.

## Estructura del proyecto

```bash
src/
  components/
  hooks/
  ml/
  model/
  parser/
  state/
  utils/
  App.tsx
  App.css
```

## Búsqueda semántica e IA externa

La barra lateral tiene dos modos de búsqueda:

- **Texto**: coincidencia literal sobre nombres de tablas y columnas. Funciona siempre.
- **Semántica**: entiende sinónimos y erratas, de modo que `clientes` encuentra `Customer`,
  `pedidos` encuentra `Order` y `ordeline` encuentra `OrderLine`.

El modo semántico tiene dos motores:

| Motor | Red | Cuándo se usa |
| --- | --- | --- |
| Local (TF-IDF + sinónimos + Levenshtein) | No usa Internet | Siempre disponible, es el modo por defecto |
| Neuronal (embeddings) | Descarga el modelo desde `huggingface.co` | Solo si lo autorizas y lo activas |

### IA externa desactivada por defecto

Pensado para equipos con salida a Internet restringida:

- La IA externa está **desactivada por defecto**.
- Hay que marcar la casilla **Permitir IA externa** y pulsar después **Activar IA**.
  Son dos acciones deliberadas y separadas.
- Sin esa autorización, el botón de activación permanece deshabilitado y el modelo
  no se descarga ni se intenta descargar.
- La autorización se recuerda entre sesiones, pero **nunca** provoca una descarga
  automática al abrir la aplicación: siempre requiere un clic en la sesión actual.
- El botón **Desactivar** libera el motor y vuelve al modo local de inmediato.
- En la compilación `offline` todo este bloque desaparece por completo.

### Qué sale por la red y qué no

- Lo único que se descarga es el modelo de embeddings (`Xenova/all-MiniLM-L6-v2`,
  unos 23 MB cuantizado), y solo al pulsar **Activar IA**.
- **El esquema nunca se envía a ningún servidor.** La inferencia se ejecuta en tu
  propio equipo con WebAssembly o WebGPU.
- El motor local no realiza ninguna petición de red en ningún caso.

### Cómo comprobarlo

```bash
grep -rn "huggingface" src/     # una sola línea, dentro de src/ml/neural.ts
grep -rn "fetch(\|XMLHttpRequest\|axios" src/   # sin resultados
```

Además, el motor de análisis (salud del esquema y tablas duplicadas) es
determinista y funciona siempre en local, sin depender de la IA externa.

## Archivos de ejemplo

La carpeta `examples/` incluye un archivo `.pdm` de ejemplo para probar la aplicación sin depender de un modelo externo.

## Nota

Este proyecto está pensado para visualizar y analizar modelos PowerDesigner en navegador. La edición se limita a los metadatos de tablas y columnas: se parchea el XML original conservando intacta su estructura y se descarga un `.pdm` nuevo. No se alteran objetos del modelo, diagramas ni opciones de generación.
