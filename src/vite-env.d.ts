/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Controla la disponibilidad de la IA externa.
   *
   * - Ausente o cualquier valor distinto de `'false'`: IA externa disponible
   *   (sigue siendo opcional para el usuario, desactivada por defecto).
   * - `'false'`: la IA externa desaparece de la interfaz y su código se elimina
   *   de la compilación. Pensado para entornos corporativos sin salida a Internet.
   */
  readonly VITE_ENABLE_EXTERNAL_AI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
