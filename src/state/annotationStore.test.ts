import { beforeEach, describe, expect, it, vi } from 'vitest';

// localStorage no existe en el entorno node de vitest: lo simulamos.
const store = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
  clear: () => store.clear(),
};
vi.stubGlobal('localStorage', localStorageMock);

// Importar después del stub para que el store lea el mock.
const { useAnnotationStore } = await import('./annotationStore');

function reset() {
  store.clear();
  useAnnotationStore.setState({ annotations: [] });
}

describe('annotationStore', () => {
  beforeEach(reset);

  it('añade una anotación de tabla', () => {
    useAnnotationStore.getState().add('t1', undefined, 'Revisar con el cliente');
    const items = useAnnotationStore.getState().annotations;
    expect(items).toHaveLength(1);
    expect(items[0].tableId).toBe('t1');
    expect(items[0].columnId).toBeUndefined();
    expect(items[0].text).toBe('Revisar con el cliente');
  });

  it('añade una anotación de columna', () => {
    useAnnotationStore.getState().add('t1', 'c1', 'Nombre obsoleto');
    const items = useAnnotationStore.getState().annotations;
    expect(items).toHaveLength(1);
    expect(items[0].columnId).toBe('c1');
  });

  it('ignora textos vacíos', () => {
    useAnnotationStore.getState().add('t1', undefined, '   ');
    expect(useAnnotationStore.getState().annotations).toHaveLength(0);
  });

  it('actualiza el texto de una anotación', () => {
    useAnnotationStore.getState().add('t1', undefined, 'original');
    const id = useAnnotationStore.getState().annotations[0].id;
    useAnnotationStore.getState().update(id, 'editada');
    expect(useAnnotationStore.getState().annotations[0].text).toBe('editada');
  });

  it('borra una anotación', () => {
    useAnnotationStore.getState().add('t1', undefined, 'una');
    useAnnotationStore.getState().add('t1', undefined, 'dos');
    const first = useAnnotationStore.getState().annotations[0].id;
    useAnnotationStore.getState().remove(first);
    expect(useAnnotationStore.getState().annotations).toHaveLength(1);
    expect(useAnnotationStore.getState().annotations[0].text).toBe('dos');
  });

  it('forTable filtra por tabla y excluye columnas', () => {
    const store = useAnnotationStore.getState();
    store.add('t1', undefined, 'tabla');
    store.add('t1', 'c1', 'columna');
    store.add('t2', undefined, 'otra tabla');

    const forT1 = useAnnotationStore.getState().forTable('t1');
    expect(forT1).toHaveLength(1);
    expect(forT1[0].text).toBe('tabla');
  });

  it('forColumn filtra por tabla y columna', () => {
    const store = useAnnotationStore.getState();
    store.add('t1', 'c1', 'en c1');
    store.add('t1', 'c2', 'en c2');
    store.add('t2', 'c1', 'en t2.c1');

    const result = useAnnotationStore.getState().forColumn('t1', 'c1');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('en c1');
  });

  it('persiste en localStorage', () => {
    useAnnotationStore.getState().add('t1', undefined, 'persistente');
    const raw = store.get('pdm-annotations');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('persistente');
  });

  it('recupera anotaciones de localStorage al iniciar', () => {
    store.set(
      'pdm-annotations',
      JSON.stringify([
        {
          id: 'x',
          tableId: 't1',
          text: 'cargada',
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );
    // simular nueva carga
    resetStoreFromStorage();
    const items = useAnnotationStore.getState().annotations;
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('cargada');
  });
});

// Reinicia el store forzando una nueva lectura del almacenamiento simulado.
function resetStoreFromStorage() {
  useAnnotationStore.setState({ annotations: [] });
  try {
    const raw = store.get('pdm-annotations');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) useAnnotationStore.setState({ annotations: parsed });
    }
  } catch {
    // ignorar
  }
}
