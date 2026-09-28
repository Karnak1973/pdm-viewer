/**
 * Versión DESHABILITADA del panel de IA externa.
 *
 * Sustituye a `ExternalAiPanel.tsx` en las compilaciones sin IA externa
 * (`npm run build:offline`) mediante el alias `@externalAiPanel` de
 * `vite.config.ts`. Al no entrar en el grafo de módulos, ni el panel ni el
 * nombre del host aparecen en el artefacto de trabajo.
 *
 * El aviso de «Modo sin conexión» lo pinta la barra lateral, que es común a
 * las dos compilaciones.
 */

import type { SemanticSearchState } from '../../hooks/useSemanticSearch';

export function ExternalAiPanel(_props: { semantic: SemanticSearchState }) {
  return null;
}
