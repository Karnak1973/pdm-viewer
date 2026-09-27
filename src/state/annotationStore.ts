/**
 * Anotaciones de usuario sobre tablas y columnas.
 *
 * Se guardan en localStorage para sobrevivir a la recarga.
 * La clave combina el id de tabla y, opcionalmente, el de columna,
 * de modo que una anotación de columna vive junto a la de su tabla.
 */

import { create } from 'zustand';

export interface Annotation {
  id: string;
  tableId: string;
  columnId?: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

interface AnnotationState {
  annotations: Annotation[];
  add: (tableId: string, columnId: string | undefined, text: string) => void;
  update: (id: string, text: string) => void;
  remove: (id: string) => void;
  forTable: (tableId: string) => Annotation[];
  forColumn: (tableId: string, columnId: string) => Annotation[];
}

const STORAGE_KEY = 'pdm-annotations';

function load(): Annotation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Annotation =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Annotation).id === 'string' &&
        typeof (item as Annotation).tableId === 'string' &&
        typeof (item as Annotation).text === 'string',
    );
  } catch {
    return [];
  }
}

function save(annotations: Annotation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations));
  } catch {
    // almacenamiento lleno o bloqueado: la anotación sigue en memoria
  }
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `ann-${Date.now()}-${counter}`;
}

export const useAnnotationStore = create<AnnotationState>((set, get) => ({
  annotations: load(),

  add: (tableId, columnId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const annotation: Annotation = {
      id: nextId(),
      tableId,
      columnId: columnId || undefined,
      text: trimmed,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const next = [...get().annotations, annotation];
    save(next);
    set({ annotations: next });
  },

  update: (id, text) => {
    const trimmed = text.trim();
    const next = get().annotations.map((item) =>
      item.id === id
        ? { ...item, text: trimmed, updatedAt: trimmed ? Date.now() : item.updatedAt }
        : item,
    );
    save(next);
    set({ annotations: next });
  },

  remove: (id) => {
    const next = get().annotations.filter((item) => item.id !== id);
    save(next);
    set({ annotations: next });
  },

  forTable: (tableId) =>
    get().annotations.filter((item) => item.tableId === tableId && !item.columnId),

  forColumn: (tableId, columnId) =>
    get().annotations.filter(
      (item) => item.tableId === tableId && item.columnId === columnId,
    ),
}));
