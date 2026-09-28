/**
 * Panel de autorización de la IA externa.
 *
 * Solo se incluye en las compilaciones que lo permiten. En el build `offline`
 * este módulo no llega a entrar en el grafo (ver el alias `@externalAiPanel`
 * en `vite.config.ts`), igual que ocurre con el motor de embeddings, de modo
 * que ni la interfaz ni el nombre del host quedan en el artefacto.
 */

import { EXTERNAL_AI_HOST } from '../../ml/buildConfig';
import type { SemanticSearchState } from '../../hooks/useSemanticSearch';

export function ExternalAiPanel({ semantic }: { semantic: SemanticSearchState }) {
  return (
    <div className="ai-control">
      <label className="ai-control__switch">
        <input
          type="checkbox"
          checked={semantic.externalAllowed}
          onChange={(event) => semantic.setExternalAllowed(event.target.checked)}
        />
        <span>Permitir IA externa</span>
      </label>

      <p className="ai-control__note">
        Desactivada por defecto. El motor local funciona siempre sin Internet y sin enviar ningún
        dato. La IA externa solo descarga el modelo desde <code>{EXTERNAL_AI_HOST}</code> y se
        ejecuta en tu equipo: el esquema nunca se sube.
      </p>

      <div className="ai-control__status">
        {semantic.mode === 'neural' ? (
          <>
            <span className="semantic-status__pill neural">IA activa · en tu equipo</span>
            <button type="button" className="semantic-status__enable ghost" onClick={semantic.releaseNeural}>
              Desactivar
            </button>
          </>
        ) : semantic.mode === 'loading' ? (
          <span className="semantic-status__pill loading">{semantic.progress || 'Cargando...'}</span>
        ) : semantic.mode === 'error' ? (
          <>
            <span className="semantic-status__pill error">Bloqueado o sin Internet · se usa el motor local</span>
            <button type="button" className="semantic-status__enable" onClick={() => void semantic.loadNeural()}>
              Reintentar
            </button>
          </>
        ) : (
          <>
            <span className="semantic-status__pill local">Motor local activo</span>
            <button
              type="button"
              className="semantic-status__enable"
              disabled={!semantic.externalAllowed}
              title={
                semantic.externalAllowed
                  ? 'Descarga el modelo y ejecuta la búsqueda neuronal'
                  : 'Autoriza primero la IA externa'
              }
              onClick={() => void semantic.loadNeural()}
            >
              Activar IA
            </button>
          </>
        )}
      </div>
    </div>
  );
}
