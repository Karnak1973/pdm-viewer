/**
 * Configuración de compilación resuelta en tiempo de empaquetado.
 *
 * Importante: la comparación con el literal `'false'` está escrita de forma
 * deliberada. Vite sustituye `import.meta.env.VITE_ENABLE_EXTERNAL_AI` por el
 * valor literal durante el empaquetado, de modo que la condición puede plegarse
 * y el código de red quedar fuera del bundle en la compilación de trabajo.
 */

/**
 * `true` cuando esta compilación permite IA externa.
 *
 * En el build `offline` vale `false`: la interfaz oculta la opción y el cargador
 * de embeddings lanza un error antes de tocar la red.
 */
export const EXTERNAL_AI_ENABLED: boolean = import.meta.env.VITE_ENABLE_EXTERNAL_AI !== 'false';

/** Dominio contactado únicamente al descargar el modelo, si está permitido. */
export const EXTERNAL_AI_HOST = 'huggingface.co';
