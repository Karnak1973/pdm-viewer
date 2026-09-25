/**
 * Preferencias locales del motor de IA externa.
 *
 * Contexto de uso: en equipos corporativos el acceso a servicios de IA suele
 * estar bloqueado. Por eso la IA externa está DESACTIVADA por defecto y solo se
 * usa si el usuario lo autoriza de forma explícita.
 *
 * Importante sobre privacidad: la única conexión de red del proyecto es la
 * descarga del modelo de embeddings. El esquema del usuario NUNCA se envía:
 * los vectores se calculan en el propio equipo con WebAssembly/WebGPU.
 */

export const EXTERNAL_AI_STORAGE_KEY = 'pdm-viewer:external-ai';

/** Dominio contactado únicamente al descargar el modelo, y solo si se autoriza. */
export const EXTERNAL_AI_HOST = 'huggingface.co';

export type ExternalAiAllowed = boolean;

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Navegación privada con almacenamiento bloqueado.
    return null;
  }
}

/**
 * Lee la autorización guardada. Devuelve `false` ante cualquier duda: es más
 * seguro quedarse sin IA que salir a Internet sin permiso.
 */
export function readExternalAiPreference(): ExternalAiAllowed {
  const store = storage();
  if (!store) return false;

  try {
    return store.getItem(EXTERNAL_AI_STORAGE_KEY) === 'allowed';
  } catch {
    return false;
  }
}

/** Guarda la autorización del usuario. */
export function writeExternalAiPreference(allowed: ExternalAiAllowed): void {
  const store = storage();
  if (!store) return;

  try {
    store.setItem(EXTERNAL_AI_STORAGE_KEY, allowed ? 'allowed' : 'blocked');
  } catch {
    // Si no se puede persistir, la preferencia sigue vigente en memoria.
  }
}
