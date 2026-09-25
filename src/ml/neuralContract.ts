/**
 * Contrato del motor de embeddings.
 *
 * Este archivo es deliberadamente ligero y SIN dependencias: lo comparten la
 * implementación real, la implementación deshabilitada y los consumidores.
 * De este modo el tipo de progreso y el identificador del modelo nunca obligan
 * a importar el runtime de Transformers.
 */

/** Modelo multilingüe-ligero: rápido, ~23 MB cuantizado y buen rendimiento en nombres. */
export const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export interface EmbeddingProgress {
  stage: 'loading' | 'ready' | 'error';
  message: string;
  progress?: number;
}

export type EmbeddingReporter = (progress: EmbeddingProgress) => void;
