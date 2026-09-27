/**
 * Índice de búsqueda global sobre un modelo PDM.
 *
 * Indexa tablas, columnas, comentarios, claves, índices y dominios
 * para poder buscarlos todos a la vez con puntuación de relevancia.
 */

import type { Model, Table } from '../model/types';

export type SearchKind = 'table' | 'column' | 'comment' | 'index' | 'key' | 'domain';

export interface SearchHit {
  kind: SearchKind;
  /** Id del objeto (tabla, columna, etc.). */
  id: string;
  /** Id de la tabla contenedora, si aplica. */
  tableId?: string;
  /** Nombre principal para mostrar. */
  title: string;
  /** Contexto secundario (tabla padre, tipo, etc.). */
  subtitle: string;
  /** Texto donde se encontró la coincidencia. */
  matchedIn: string;
  /** Puntuación 0..1 (mayor = más relevante). */
  score: number;
}

export interface SearchFilters {
  kinds: Set<SearchKind> | null;
  /** Filtra por código de tabla que empiece por este prefijo (esquema/módulo). */
  prefix: string | null;
}

const KIND_WEIGHT: Record<SearchKind, number> = {
  table: 1.0,
  column: 0.85,
  comment: 0.6,
  key: 0.5,
  index: 0.5,
  domain: 0.4,
};

function scoreMatch(query: string, text: string, weight: number): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (t === q) return weight;
  if (t.startsWith(q)) return weight * 0.95;
  if (t.includes(q)) return weight * 0.8;

  // Coincidencia por palabras sueltas (búsqueda difusa básica).
  const words = t.split(/[\s_]+/).filter(Boolean);
  const queryWords = q.split(/\s+/).filter(Boolean);
  if (queryWords.length > 1) {
    const matched = queryWords.filter((qw) => words.some((w) => w.includes(qw)));
    if (matched.length === queryWords.length) return weight * 0.7;
    if (matched.length > 0) return weight * 0.5;
  }

  // Subcadena en mitad de palabra (para camelCase/snake_case).
  if (t.replace(/[_\s]/g, '').includes(q.replace(/\s/g, ''))) return weight * 0.65;

  return null;
}

function tablePrefix(table: Table): string {
  return table.code.includes('_') ? table.code.split('_')[0] : '';
}

/** Busca en el modelo completo y devuelve los resultados ordenados. */
export function globalSearch(
  model: Model,
  rawQuery: string,
  filters?: SearchFilters,
): SearchHit[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const hits: SearchHit[] = [];

  const passesFilters = (kind: SearchKind, table?: Table): boolean => {
    if (filters?.kinds && !filters.kinds.has(kind)) return false;
    if (filters?.prefix && table && !tablePrefix(table).toLowerCase().startsWith(filters.prefix.toLowerCase())) {
      return false;
    }
    return true;
  };

  const push = (
    kind: SearchKind,
    id: string,
    title: string,
    subtitle: string,
    matchedIn: string,
    weight: number,
    table?: Table,
    tableId?: string,
  ) => {
    if (!passesFilters(kind, table)) return;
    const score = scoreMatch(query, matchedIn, weight) ?? scoreMatch(query, title, weight);
    if (score === null) return;
    hits.push({ kind, id, tableId, title, subtitle, matchedIn, score });
  };

  for (const table of model.tables) {
    // Tabla: nombre, código y comentario.
    push('table', table.id, table.name, `${table.code} · ${table.columns.length} columnas`, table.name, KIND_WEIGHT.table, table);
    if (table.code.toLowerCase() !== table.name.toLowerCase()) {
      push('table', table.id, table.name, `${table.code} · ${table.columns.length} columnas`, table.code, KIND_WEIGHT.table * 0.95, table);
    }
    if (table.comment) {
      push('comment', table.id, table.name, 'Comentario de tabla', table.comment, KIND_WEIGHT.comment, table);
    }

    // Columnas: nombre, código y comentario.
    for (const column of table.columns) {
      const isPk = table.primaryKey?.includes(column.id) ?? false;
      const badge = isPk ? 'PK' : column.dataType;
      push('column', column.id, column.name, `${table.name} · ${badge}`, column.name, KIND_WEIGHT.column, table, table.id);
      if (column.code.toLowerCase() !== column.name.toLowerCase()) {
        push('column', column.id, column.name, `${table.name} · ${badge}`, column.code, KIND_WEIGHT.column * 0.95, table, table.id);
      }
      if (column.comment) {
        push('comment', column.id, `${table.name}.${column.name}`, 'Comentario de columna', column.comment, KIND_WEIGHT.comment, table, table.id);
      }
    }

    // Claves.
    for (const key of table.keys) {
      push('key', key.id, key.name, `${table.name} · ${key.isPrimary ? 'PK' : 'AK'}`, key.name, KIND_WEIGHT.key, table, table.id);
    }

    // Índices.
    for (const index of table.indexes) {
      push('index', index.id, index.name, `${table.name} · ${index.unique ? 'UNIQUE' : 'idx'}`, index.name, KIND_WEIGHT.index, table, table.id);
    }
  }

  // Dominios.
  for (const domain of model.domains) {
    push('domain', domain.id, domain.name, `Dominio · ${domain.dataType}`, domain.name, KIND_WEIGHT.domain);
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/** Prefijos (esquemas/módulos) disponibles en el modelo. */
export function availablePrefixes(model: Model): string[] {
  const prefixes = new Set<string>();
  for (const table of model.tables) {
    const prefix = tablePrefix(table);
    if (prefix) prefixes.add(prefix);
  }
  return [...prefixes].sort();
}

/** Agrupa hits por tipo para la UI. */
export function groupHits(hits: SearchHit[]): Map<SearchKind, SearchHit[]> {
  const groups = new Map<SearchKind, SearchHit[]>();
  for (const hit of hits) {
    const list = groups.get(hit.kind) ?? [];
    list.push(hit);
    groups.set(hit.kind, list);
  }
  return groups;
}
