# PDM Viewer

Visor web para abrir archivos PowerDesigner `.pdm` y explorar el esquema de datos en una vista tipo diagrama entidad-relación.

## Características

- carga de archivos `.pdm` y `.xml`
- visualización de tablas, columnas, claves primarias, relaciones e índices
- vista de diagrama con nodos tipo entidad
- panel lateral con listados y búsqueda
- detalle de tabla con metadatos y SQL DDL
- generación de SQL compatible con Oracle
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

```bash
npm run build
```

Para previsualizar la versión compilada:

```bash
npm run preview
```

## Uso

1. Inicia la aplicación con `npm run dev`.
2. En la pantalla principal, arrastra y suelta un archivo `.pdm` o pulsa para seleccionar uno.
3. El visor cargará el modelo y mostrará:
   - el árbol de tablas a la izquierda
   - el diagrama ER en el centro
   - el detalle de la tabla seleccionada a la derecha
4. Puedes cambiar entre las vistas de `Detalles`, `SQL` y `Modelo`.
5. Si quieres copiar el DDL generado, usa el botón `Copiar SQL`.

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

Este proyecto está pensado para visualizar y analizar modelos PowerDesigner en navegador, no para editarlos desde el cliente.
