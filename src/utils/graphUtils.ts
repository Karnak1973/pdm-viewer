/**
 * Utilidades de grafo para el diagrama ER:
 * vecinos, caminos mínimos, detección de ciclos y
 * marcadores semánticos de tablas.
 */

import type { Model, Table } from '../model/types';

export interface SemanticFlags {
  noPk: Set<string>;
  orphan: Set<string>;
  god: Set<string>;
  fkNoIndex: Set<string>;
  nullableKey: Set<string>;
}

const GOD_THRESHOLD = 8;

/** Construye el grafo no dirigido de tablas a partir de las referencias. */
export function buildAdjacency(model: Model): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    if (!adj.has(id)) adj.set(id, new Set());
  };

  for (const table of model.tables) ensure(table.id);
  for (const ref of model.references) {
    ensure(ref.parentTable);
    ensure(ref.childTable);
    adj.get(ref.parentTable)!.add(ref.childTable);
    adj.get(ref.childTable)!.add(ref.parentTable);
  }
  return adj;
}

/** Tablas vecinas directas de una tabla. */
export function directNeighbors(model: Model, tableId: string): Set<string> {
  const result = new Set<string>();
  for (const ref of model.references) {
    if (ref.parentTable === tableId) result.add(ref.childTable);
    if (ref.childTable === tableId) result.add(ref.parentTable);
  }
  result.delete(tableId);
  return result;
}

/** Tablas alcanzables hasta N saltos desde la tabla origen. */
export function neighborsWithinHops(model: Model, tableId: string, hops: number): Set<string> {
  const visited = new Set<string>([tableId]);
  let frontier = [tableId];

  for (let hop = 0; hop < hops; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of directNeighbors(model, id)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  visited.delete(tableId);
  return visited;
}

/**
 * Camino mínimo (BFS) entre dos tablas.
 * Devuelve la secuencia de ids de tabla o null si no existe camino.
 */
export function shortestPath(model: Model, from: string, to: string): string[] | null {
  if (from === to) return [from];

  const prev = new Map<string, string>();
  const visited = new Set<string>([from]);
  const queue: string[] = [from];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of directNeighbors(model, current)) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      prev.set(neighbor, current);

      if (neighbor === to) {
        const path = [to];
        let node = to;
        while (prev.has(node)) {
          node = prev.get(node)!;
          path.unshift(node);
        }
        return path;
      }
      queue.push(neighbor);
    }
  }

  return null;
}

/** Aristas del camino mínimo (pares from->to) para resaltarlas. */
export function pathEdgeIds(model: Model, path: string[]): Set<string> {
  const ids = new Set<string>();
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    for (const ref of model.references) {
      const match =
        (ref.parentTable === a && ref.childTable === b) ||
        (ref.parentTable === b && ref.childTable === a);
      if (match) ids.add(ref.id);
    }
  }
  return ids;
}

/** Detecta ciclos de FK en el grafo dirigido (parent → child). */
export function findFkCycles(model: Model): string[][] {
  const adj = new Map<string, string[]>();
  for (const table of model.tables) adj.set(table.id, []);
  for (const ref of model.references) {
    const list = adj.get(ref.parentTable);
    if (list && ref.parentTable !== ref.childTable) list.push(ref.childTable);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  const dfs = (id: string) => {
    visited.add(id);
    inStack.add(id);
    stack.push(id);

    for (const neighbor of adj.get(id) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (inStack.has(neighbor)) {
        const idx = stack.indexOf(neighbor);
        if (idx >= 0) cycles.push(stack.slice(idx));
      }
    }

    stack.pop();
    inStack.delete(id);
  };

  for (const table of model.tables) {
    if (!visited.has(table.id)) dfs(table.id);
  }

  return cycles;
}

/** Marca tablas sin PK, huérfanas, "god", FK sin índice y columnas clave anulables. */
export function computeSemanticFlags(model: Model): SemanticFlags {
  const noPk = new Set<string>();
  const orphan = new Set<string>();
  const god = new Set<string>();
  const fkNoIndex = new Set<string>();
  const nullableKey = new Set<string>();

  const fkColumns = new Set<string>();
  for (const ref of model.references) {
    for (const join of ref.joins) fkColumns.add(join.childColumn);
  }

  const adjacency = buildAdjacency(model);

  for (const table of model.tables) {
    const pk = table.primaryKey ?? table.keys.find((k) => k.isPrimary)?.columns ?? [];
    if (pk.length === 0 && table.columns.length > 0) noPk.add(table.id);

    const degree = adjacency.get(table.id)?.size ?? 0;
    if (degree === 0 && model.tables.length > 1) orphan.add(table.id);
    if (degree >= GOD_THRESHOLD) god.add(table.id);

    for (const columnId of pk) {
      const column = table.columns.find((c) => c.id === columnId);
      if (column && !column.mandatory) nullableKey.add(table.id);
    }

    const indexed = new Set<string>();
    for (const index of table.indexes) {
      const leading = index.columns[0];
      if (leading) indexed.add(leading);
    }
    for (const key of table.keys) {
      for (const colId of key.columns) indexed.add(colId);
    }

    for (const column of table.columns) {
      if (fkColumns.has(column.id) && !indexed.has(column.id)) fkNoIndex.add(table.id);

      if (pk.includes(column.id) && !column.mandatory) nullableKey.add(table.id);
    }
  }

  return { noPk, orphan, god, fkNoIndex, nullableKey };
}

/** Conteo de relaciones por tabla (grado de entrada + salida). */
export function relationCounts(model: Model): Map<string, number> {
  const counts = new Map<string, number>();
  for (const table of model.tables) counts.set(table.id, 0);
  for (const ref of model.references) {
    counts.set(ref.parentTable, (counts.get(ref.parentTable) ?? 0) + 1);
    counts.set(ref.childTable, (counts.get(ref.childTable) ?? 0) + 1);
  }
  return counts;
}

/** Métrica por tabla para el mapa de calor. */
export type HeatMetric = 'columns' | 'relations' | 'indexes' | 'issues';

export function heatValues(model: Model, metric: HeatMetric, issuesByTable?: Map<string, number>): Map<string, number> {
  const result = new Map<string, number>();

  if (metric === 'relations') {
    return relationCounts(model);
  }

  for (const table of model.tables) {
    if (metric === 'columns') result.set(table.id, table.columns.length);
    else if (metric === 'indexes') result.set(table.id, table.indexes.length);
    else if (metric === 'issues') result.set(table.id, issuesByTable?.get(table.id) ?? 0);
  }
  return result;
}

/** Devuelve la clase de color 0..4 según el valor relativo. */
export function heatClass(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  const ratio = (value - min) / (max - min);
  if (ratio < 0.25) return 0;
  if (ratio < 0.5) return 1;
  if (ratio < 0.75) return 2;
  return 3;
}

/** Agrupa tablas por el prefijo antes del primer guion bajo. */
export function groupByPrefix(tables: Table[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const table of tables) {
    const prefix = table.code.includes('_') ? table.code.split('_')[0] : '(sin prefijo)';
    const list = groups.get(prefix) ?? [];
    list.push(table.id);
    groups.set(prefix, list);
  }
  return groups;
}
