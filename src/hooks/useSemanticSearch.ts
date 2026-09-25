/**
 * Hook de búsqueda semántica sobre el modelo cargado.
 *
 * Arranca siempre en modo léxico (instantáneo, sin red). El modo neuronal se
 * activa bajo demanda porque implica descargar un modelo de embeddings.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Model } from '../model/types';
import { EXTERNAL_AI_ENABLED } from '../ml/buildConfig';
import { resetNeural } from '@neural';
import { readExternalAiPreference, writeExternalAiPreference } from '../ml/preferences';
import { createSchemaIndex, type SearchMode, type SemanticResult } from '../ml/schemaIndex';

export interface SemanticSearchState {
  mode: SearchMode;
  progress: string;
  results: SemanticResult[] | null;
  scoreFor: (tableId: string) => number | undefined;
  isSemantic: boolean;
  /** `false` cuando esta compilación no admite IA externa (build offline). */
  externalAiAvailable: boolean;
  /** Indica si el usuario ha autorizado el uso de IA externa (persistente). */
  externalAllowed: boolean;
  /** Cambia la autorización; al revocarla se libera el motor y no se vuelve a usar. */
  setExternalAllowed: (allowed: boolean) => void;
  /** Descarga el modelo y activa el motor neuronal. Requiere autorización previa. */
  loadNeural: () => Promise<void>;
  /** Libera el motor neuronal y vuelve al motor local. */
  releaseNeural: () => void;
}

export function useSemanticSearch(
  model: Model,
  enabled: boolean,
  query: string,
): SemanticSearchState {
  const index = useMemo(() => createSchemaIndex(model), [model]);

  const [mode, setMode] = useState<SearchMode>('lexical');
  const [progress, setProgress] = useState('');
  const [results, setResults] = useState<SemanticResult[] | null>(null);
  const [externalAllowed, setExternalAllowedState] = useState(readExternalAiPreference);

  // Al cambiar de modelo el índice se reconstruye, así que el modo vuelve atrás.
  useEffect(() => {
    setMode('lexical');
    setProgress('');
  }, [index]);

  const trimmed = query.trim();

  useEffect(() => {
    if (!enabled || trimmed.length === 0) {
      setResults(null);
      return;
    }

    let cancelled = false;

    const run = async () => {
      const queryVector = await index.embedQuery(trimmed);
      if (cancelled) return;

      setResults(index.search(trimmed, model.tables.length, queryVector ?? undefined));
    };

    void run().catch(() => {
      // Ante cualquier fallo del motor neuronal se degrada al motor local,
      // que siempre está disponible porque no depende de la red.
      if (!cancelled) setResults(index.search(trimmed, model.tables.length));
    });

    return () => {
      cancelled = true;
    };
    // `mode` entra en las dependencias para recalcular los resultados en cuanto
    // el motor neuronal termina de cargar, sin obligar a reescribir la consulta.
  }, [enabled, trimmed, index, model.tables.length, mode]);

  /** Libera el pipeline cargado y vuelve al motor local. */
  const releaseNeural = useCallback(() => {
    // Hay que desactivar el índice además del pipeline: si no, la siguiente
    // consulta volvería a descargar el modelo de forma silenciosa.
    index.disableNeural();
    resetNeural();
    setMode('lexical');
    setProgress('');
  }, [index]);

  const setExternalAllowed = useCallback(
    (allowed: boolean) => {
      setExternalAllowedState(allowed);
      writeExternalAiPreference(allowed);

      // Revocar el permiso corta inmediatamente cualquier uso del motor neuronal.
      if (!allowed) releaseNeural();
    },
    [releaseNeural],
  );

  const loadNeural = useCallback(async () => {
    // Triple barrera: compilación sin IA, falta de autorización o carga en curso.
    // Ninguna de ellas llega siquiera a intentar la descarga del modelo.
    if (!EXTERNAL_AI_ENABLED) return;
    if (!externalAllowed) return;
    if (mode === 'neural' || mode === 'loading') return;

    // El estado se marca como "cargando" antes del await para que el usuario
    // reciba respuesta inmediata: la descarga del modelo puede tardar.
    setMode('loading');
    setProgress('Preparando motor neuronal...');

    const result = await index.enableNeural((update) => setProgress(update.message));
    setMode(result);

    if (result === 'neural') {
      setProgress('Modelo ejecutándose en tu equipo');
    }
  }, [index, mode, externalAllowed]);

  // Índice de puntuaciones para pintar la afinidad en la lista de tablas.
  const scores = useRef(new Map<string, number>());
  scores.current = new Map((results ?? []).map((hit) => [hit.id, hit.score]));

  const scoreFor = useCallback((tableId: string) => scores.current.get(tableId), []);

  return {
    mode,
    progress,
    results,
    scoreFor,
    isSemantic: enabled && results !== null,
    externalAiAvailable: EXTERNAL_AI_ENABLED,
    externalAllowed,
    setExternalAllowed,
    loadNeural,
    releaseNeural,
  };
}
