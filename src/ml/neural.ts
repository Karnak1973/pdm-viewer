/**
 * Embeddings neuronales en el navegador con Transformers.js.
 *
 * El modelo se carga de forma diferida y se cachea en el navegador, de modo que
 * la aplicación arranca ligera y solo descarga el modelo si el usuario activa la
 * búsqueda neuronal. Si algo falla (sin red, sin WebAssembly), se lanza un error
 * controlado para que la capa superior use el motor léxico local.
 */

import { normalizeVector } from './vectorizer';
import { EXTERNAL_AI_HOST } from './preferences';

/** Modelo multilingüe-ligero: rápido, ~23 MB cuantizado y buen rendimiento en nombres. */
export const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export interface EmbeddingProgress {
  stage: 'loading' | 'ready' | 'error';
  message: string;
  progress?: number;
}

interface TensorLike {
  tolist: () => number[][] | number[];
}

type FeatureExtractor = (
  input: string | string[],
  options: Record<string, unknown>,
) => Promise<TensorLike>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

/**
 * Carga (una sola vez) el pipeline de extracción de características.
 *
 * Esta función es el ÚNICO punto del proyecto que puede contactar con Internet.
 * Solo se invoca desde `enableNeural`, que a su vez exige que el usuario haya
 * autorizado explícitamente la IA externa. Ninguna parte del esquema se envía:
 * el modelo se descarga y la inferencia ocurre en el equipo.
 *
 * `env.allowLocalModels = false` evita peticiones a rutas locales inexistentes.
 */
async function loadExtractor(onProgress?: (progress: EmbeddingProgress) => void): Promise<FeatureExtractor> {
  if (extractorPromise) return extractorPromise;

  extractorPromise = (async () => {
    onProgress?.({ stage: 'loading', message: `Descargando modelo desde ${EXTERNAL_AI_HOST}...` });

    const transformers = await import('@huggingface/transformers');
    const { pipeline, env } = transformers as unknown as {
      pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<FeatureExtractor>;
      env: { allowLocalModels: boolean; allowRemoteModels: boolean; useBrowserCache: boolean };
    };

    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;

    const extractor = await pipeline('feature-extraction', DEFAULT_MODEL_ID, { dtype: 'q8' });
    onProgress?.({ stage: 'ready', message: 'Modelo cargado en local' });
    return extractor;
  })().catch((error: unknown) => {
    extractorPromise = null;
    onProgress?.({
      stage: 'error',
      message: error instanceof Error ? error.message : 'No se pudo descargar el modelo',
    });
    throw error instanceof Error ? error : new Error('No se pudo descargar el modelo de embeddings');
  });

  return extractorPromise;
}

/** Comprueba si el modelo ya está en memoria, sin forzar su descarga. */
export function isNeuralReady(): boolean {
  return extractorPromise !== null;
}

/** Libera el pipeline cargado (útil al cambiar de modelo). */
export function resetNeural(): void {
  extractorPromise = null;
}

/**
 * Calcula embeddings normalizados para una lista de textos.
 * Devuelve vectores de norma unitaria, así que la similitud es un producto escalar.
 */
export async function embedTexts(
  texts: string[],
  onProgress?: (progress: EmbeddingProgress) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extractor = await loadExtractor(onProgress);

  const output = await extractor(texts, {
    pooling: 'mean',
    normalize: true,
  });

  const raw = output.tolist();

  // Con una sola entrada, `tolist()` devuelve number[] en lugar de number[][].
  const rows = Array.isArray(raw[0]) ? (raw as number[][]) : [raw as unknown as number[]];

  return rows.map((row) => normalizeVector(row));
}

/** Prefijo de texto que describe una tabla; se usa tanto en el motor local como en el neuronal. */
export function preloadModel(onProgress?: (progress: EmbeddingProgress) => void): Promise<void> {
  return loadExtractor(onProgress).then(() => undefined);
}
