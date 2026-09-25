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
  model/
  parser/
  state/
  utils/
  App.tsx
  App.css
```

## Archivos de ejemplo

La carpeta `examples/` incluye un archivo `.pdm` de ejemplo para probar la aplicación sin depender de un modelo externo.

## Nota

Este proyecto está pensado para visualizar y analizar modelos PowerDesigner en navegador, no para editarlos desde el cliente.
