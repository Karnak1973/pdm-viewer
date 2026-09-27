/**
 * Estado del diff entre dos modelos PDM.
 *
 * El modelo base es el cargado actualmente en la app.
 * El modelo objetivo se carga desde un segundo fichero .pdm.
 */

import { create } from 'zustand';
import type { Model } from '../model/types';
import type { ModelDiff } from '../utils/modelDiff';
import { diffModels } from '../utils/modelDiff';

interface DiffState {
  targetModel: Model | null;
  targetName: string | null;
  diff: ModelDiff | null;
  error: string | null;

  setTarget: (model: Model, name: string) => void;
  clearTarget: () => void;
  recompute: (base: Model) => void;
}

export const useDiffStore = create<DiffState>((set, get) => ({
  targetModel: null,
  targetName: null,
  diff: null,
  error: null,

  setTarget: (model, name) => {
    set({ targetModel: model, targetName: name, error: null, diff: null });
  },

  clearTarget: () => set({ targetModel: null, targetName: null, diff: null, error: null }),

  recompute: (base) => {
    const target = get().targetModel;
    if (!target) {
      set({ diff: null });
      return;
    }
    try {
      const diff = diffModels(base, target);
      set({ diff, error: null });
    } catch (err) {
      set({ diff: null, error: err instanceof Error ? err.message : 'Error al comparar modelos.' });
    }
  },
}));
