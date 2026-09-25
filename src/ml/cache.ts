/**
 * Caché persistente sencilla sobre IndexedDB.
 *
 * Se usa para no recalcular embeddings cada vez que se recarga un modelo.
 * Todas las operaciones degradan a "sin caché" si el entorno no la soporta
 * (SSR, navegación privada estricta, tests en Node).
 */

const DATABASE_NAME = 'pdm-viewer-ml';
const STORE_NAME = 'embeddings';
const VERSION = 1;

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!isIndexedDbAvailable()) return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DATABASE_NAME, VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Recupera un valor de la caché o `null` si no existe o falla. */
export async function readCache<T>(key: string): Promise<T | null> {
  const database = await openDatabase();
  if (!database) return null;

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(key);

      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => resolve(null);
      transaction.oncomplete = () => database.close();
    } catch {
      resolve(null);
    }
  });
}

/** Guarda un valor en la caché. Silencia cualquier error de escritura. */
export async function writeCache<T>(key: string, value: T): Promise<void> {
  const database = await openDatabase();
  if (!database) return;

  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(value, key);

      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        resolve();
      };
    } catch {
      resolve();
    }
  });
}

/** Elimina una entrada concreta de la caché. */
export async function deleteCache(key: string): Promise<void> {
  const database = await openDatabase();
  if (!database) return;

  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        resolve();
      };
    } catch {
      resolve();
    }
  });
}
