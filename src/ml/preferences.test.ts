import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTERNAL_AI_STORAGE_KEY,
  readExternalAiPreference,
  writeExternalAiPreference,
} from './preferences';

/** Implementación mínima en memoria para no depender de un DOM real. */
function createStorageStub(): Storage {
  const data = new Map<string, string>();

  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  } as Storage;
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function useStorage(storage: Storage | undefined) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (original) {
    Object.defineProperty(globalThis, 'localStorage', original);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
  vi.restoreAllMocks();
});

describe('preferencia de IA externa', () => {
  it('está desactivada por defecto: sin nada guardado no se autoriza salir a Internet', () => {
    useStorage(createStorageStub());
    expect(readExternalAiPreference()).toBe(false);
  });

  it('recuerda la autorización del usuario', () => {
    const storage = createStorageStub();
    useStorage(storage);

    writeExternalAiPreference(true);
    expect(storage.getItem(EXTERNAL_AI_STORAGE_KEY)).toBe('allowed');
    expect(readExternalAiPreference()).toBe(true);

    writeExternalAiPreference(false);
    expect(storage.getItem(EXTERNAL_AI_STORAGE_KEY)).toBe('blocked');
    expect(readExternalAiPreference()).toBe(false);
  });

  it('trata cualquier valor inesperado como no autorizado', () => {
    const storage = createStorageStub();
    useStorage(storage);

    storage.setItem(EXTERNAL_AI_STORAGE_KEY, 'quizá');
    expect(readExternalAiPreference()).toBe(false);

    storage.setItem(EXTERNAL_AI_STORAGE_KEY, 'true');
    expect(readExternalAiPreference()).toBe(false);
  });

  it('sobrevive a un almacenamiento no disponible', () => {
    useStorage(undefined);

    expect(() => writeExternalAiPreference(true)).not.toThrow();
    expect(readExternalAiPreference()).toBe(false);
  });

  it('no propaga errores si el almacenamiento está bloqueado', () => {
    const hostile = createStorageStub();
    vi.spyOn(hostile, 'getItem').mockImplementation(() => {
      throw new Error('almacenamiento bloqueado');
    });
    vi.spyOn(hostile, 'setItem').mockImplementation(() => {
      throw new Error('almacenamiento bloqueado');
    });
    useStorage(hostile);

    expect(() => writeExternalAiPreference(true)).not.toThrow();
    expect(readExternalAiPreference()).toBe(false);
  });
});
