import { create } from 'zustand';
import type { Model } from '../model/types';
import { createDemoModel } from '../utils/sampleModel';

interface ModelState {
  model: Model;
  selectedTableId: string | null;
  search: string;
  setModel: (model: Model) => void;
  setSelectedTable: (tableId: string) => void;
  setSearch: (value: string) => void;
}

export const useModelStore = create<ModelState>((set) => ({
  model: createDemoModel(),
  selectedTableId: createDemoModel().tables[0]?.id ?? null,
  search: '',
  setModel: (model) =>
    set({
      model,
      selectedTableId: model.tables[0]?.id ?? null,
    }),
  setSelectedTable: (tableId) => set({ selectedTableId: tableId }),
  setSearch: (value) => set({ search: value }),
}));
