import { create } from 'zustand';
import type { Model } from '../model/types';
import { createDemoModel } from '../utils/sampleModel';
import type { HeatMetric } from '../utils/graphUtils';

export type LayerView =
  | 'all'
  | 'tables'
  | 'fk'
  | 'indexes'
  | 'domains'
  | 'comments'
  | 'audit';

interface ModelState {
  model: Model;
  selectedTableId: string | null;
  search: string;
  view: 'diagram' | 'analysis' | 'diff' | 'relations';

  layer: LayerView;
  collapsed: Set<string>;
  hideNonKey: boolean;
  focusHops: number | null;
  heatMetric: HeatMetric | null;
  pathFrom: string | null;
  pathTo: string | null;
  pathResult: string[] | null;

  setModel: (model: Model) => void;
  setSelectedTable: (tableId: string) => void;
  setSearch: (value: string) => void;
  setView: (view: 'diagram' | 'analysis' | 'diff' | 'relations') => void;

  setLayer: (layer: LayerView) => void;
  toggleCollapse: (tableId: string) => void;
  setHideNonKey: (value: boolean) => void;
  setFocusHops: (hops: number | null) => void;
  setHeatMetric: (metric: HeatMetric | null) => void;
  setPathPoint: (side: 'from' | 'to', tableId: string | null) => void;
  clearPath: () => void;
}

const initialPath = { pathFrom: null, pathTo: null, pathResult: null };

export const useModelStore = create<ModelState>((set) => ({
  model: createDemoModel(),
  selectedTableId: createDemoModel().tables[0]?.id ?? null,
  search: '',
  view: 'diagram',

  layer: 'all',
  collapsed: new Set<string>(),
  hideNonKey: false,
  focusHops: null,
  heatMetric: null,
  ...initialPath,

  setModel: (model) =>
    set({
      model,
      selectedTableId: model.tables[0]?.id ?? null,
      collapsed: new Set<string>(),
      focusHops: null,
      heatMetric: null,
      layer: 'all',
      hideNonKey: false,
      ...initialPath,
    }),

  setSelectedTable: (tableId) => set({ selectedTableId: tableId }),
  setSearch: (value) => set({ search: value }),
  setView: (view) => set({ view }),

  setLayer: (layer) => set({ layer }),
  toggleCollapse: (tableId) =>
    set((state) => {
      const next = new Set(state.collapsed);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return { collapsed: next };
    }),
  setHideNonKey: (value) => set({ hideNonKey: value }),
  setFocusHops: (hops) => set({ focusHops: hops }),
  setHeatMetric: (metric) => set({ heatMetric: metric }),

  setPathPoint: (side, tableId) =>
    set(() => {
      if (side === 'from') return { pathFrom: tableId, pathResult: null };
      return { pathTo: tableId, pathResult: null };
    }),

  clearPath: () => set({ ...initialPath }),
}));
