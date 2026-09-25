/**
 * Implementación DESHABILITADA del motor de embeddings.
 *
 * Este módulo sustituye a `neural.ts` en las compilaciones sin IA externa
 * (`npm run build:offline`). No importa Transformers ni ONNX, así que en esas
 * compilaciones no se empaqueta ni un solo byte de código de red.
 *
 * La sustitución se realiza con un alias de resolución en `vite.config.ts`,
 * de modo que el código de red no llega a entrar nunca en el grafo de módulos.
 */

import type { EmbeddingProgress, EmbeddingReporter } from './neuralContract';

const DISABLED_MESSAGE =
  'La IA externa está deshabilitada en esta compilación. Se está usando el motor local.';

/** Estado del modelo: nunca hay modelo cargado en esta compilación. */
export function isNeuralReady(): boolean {
  return false;
}

/** No hay nada que liberar. */
export function resetNeural(): void {
  // Intencionadamente vacío.
}

/** Lanza un error controlado sin realizar ninguna petición de red. */
export async function embedTexts(
  _texts: string[],
  onProgress?: EmbeddingReporter,
): Promise<number[][]> {
  onProgress?.({ stage: 'error', message: DISABLED_MESSAGE });
  throw new Error(DISABLED_MESSAGE);
}

/** Lanza un error controlado sin realizar ninguna petición de red. */
export function preloadModel(onProgress?: EmbeddingReporter): Promise<void> {
  onProgress?.({ stage: 'error', message: DISABLED_MESSAGE });
  return Promise.reject(new Error(DISABLED_MESSAGE));
}

/** Mensaje que la interfaz puede mostrar cuando se pide un motor inexistente. */
export const NEURAL_DISABLED_MESSAGE = DISABLED_MESSAGE;

export type { EmbeddingProgress };
