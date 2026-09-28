/**
 * Motor de diff entre dos modelos PDM.
 *
 * Compara tablas, columnas, relaciones, índices y claves,
 * emparejándolas por código (o nombre) y detectando cambios de tipo,
 * longitud, obligatoriedad, etc.
 */

import type { Model, Table, Column, Reference, Index, Key } from '../model/types';

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export interface ObjectDiff {
  kind: ChangeKind;
  id: string;
  name: string;
  /** Nombre del padre (tabla que contiene la columna/índice, si aplica). */
  parent?: string;
  changes: FieldChange[];
}

export interface ModelDiff {
  tables: ObjectDiff[];
  columns: ObjectDiff[];
  references: ObjectDiff[];
  indexes: ObjectDiff[];
  keys: ObjectDiff[];
  summary: {
    added: number;
    removed: number;
    modified: number;
    total: number;
  };
}

function fmt(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

function diffColumn(base: Column, target: Column): FieldChange[] {
  const changes: FieldChange[] = [];
  if (base.code !== target.code) {
    changes.push({ field: 'Código', before: base.code, after: target.code });
  }
  if (base.name !== target.name) {
    changes.push({ field: 'Nombre', before: base.name, after: target.name });
  }
  if (base.dataType !== target.dataType) {
    changes.push({ field: 'Tipo', before: base.dataType, after: target.dataType });
  }
  if ((base.length ?? 0) !== (target.length ?? 0)) {
    changes.push({ field: 'Longitud', before: fmt(base.length), after: fmt(target.length) });
  }
  if ((base.precision ?? 0) !== (target.precision ?? 0)) {
    changes.push({ field: 'Precisión', before: fmt(base.precision), after: fmt(target.precision) });
  }
  if (base.mandatory !== target.mandatory) {
    changes.push({
      field: 'Nullable',
      before: base.mandatory ? 'NOT NULL' : 'NULL',
      after: target.mandatory ? 'NOT NULL' : 'NULL',
    });
  }
  if (base.identity !== target.identity) {
    changes.push({ field: 'Identity', before: fmt(base.identity), after: fmt(target.identity) });
  }
  if ((base.defaultValue ?? '') !== (target.defaultValue ?? '')) {
    changes.push({ field: 'Default', before: fmt(base.defaultValue), after: fmt(target.defaultValue) });
  }
  if ((base.comment ?? '') !== (target.comment ?? '')) {
    changes.push({ field: 'Comentario', before: fmt(base.comment), after: fmt(target.comment) });
  }
  return changes;
}

function diffIndex(base: Index, target: Index): FieldChange[] {
  const changes: FieldChange[] = [];
  if (base.name !== target.name) {
    changes.push({ field: 'Nombre', before: base.name, after: target.name });
  }
  if (base.unique !== target.unique) {
    changes.push({ field: 'Unique', before: fmt(base.unique), after: fmt(target.unique) });
  }
  const baseCols = [...base.columns].sort().join(',');
  const targetCols = [...target.columns].sort().join(',');
  if (baseCols !== targetCols) {
    changes.push({ field: 'Columnas', before: baseCols || '—', after: targetCols || '—' });
  }
  return changes;
}

function diffKey(base: Key, target: Key): FieldChange[] {
  const changes: FieldChange[] = [];
  if (base.name !== target.name) {
    changes.push({ field: 'Nombre', before: base.name, after: target.name });
  }
  if (base.isPrimary !== target.isPrimary) {
    changes.push({ field: 'Primary', before: fmt(base.isPrimary), after: fmt(target.isPrimary) });
  }
  const baseCols = [...base.columns].sort().join(',');
  const targetCols = [...target.columns].sort().join(',');
  if (baseCols !== targetCols) {
    changes.push({ field: 'Columnas', before: baseCols || '—', after: targetCols || '—' });
  }
  return changes;
}

function diffReference(base: Reference, target: Reference): FieldChange[] {
  const changes: FieldChange[] = [];
  if (base.parentTable !== target.parentTable) {
    changes.push({ field: 'Padre', before: base.parentTable, after: target.parentTable });
  }
  if (base.childTable !== target.childTable) {
    changes.push({ field: 'Hijo', before: base.childTable, after: target.childTable });
  }
  if (base.cardinality !== target.cardinality) {
    changes.push({ field: 'Cardinalidad', before: base.cardinality, after: target.cardinality });
  }
  if ((base.onDelete ?? '') !== (target.onDelete ?? '')) {
    changes.push({ field: 'ON DELETE', before: fmt(base.onDelete), after: fmt(target.onDelete) });
  }
  if ((base.onUpdate ?? '') !== (target.onUpdate ?? '')) {
    changes.push({ field: 'ON UPDATE', before: fmt(base.onUpdate), after: fmt(target.onUpdate) });
  }
  const baseJoins = base.joins
    .map((j) => `${j.parentColumn}→${j.childColumn}`)
    .sort()
    .join(';');
  const targetJoins = target.joins
    .map((j) => `${j.parentColumn}→${j.childColumn}`)
    .sort()
    .join(';');
  if (baseJoins !== targetJoins) {
    changes.push({ field: 'Joins', before: baseJoins || '—', after: targetJoins || '—' });
  }
  return changes;
}

function diffTable(base: Table, target: Table): FieldChange[] {
  const changes: FieldChange[] = [];
  if (base.code !== target.code) {
    changes.push({ field: 'Código', before: base.code, after: target.code });
  }
  if (base.name !== target.name) {
    changes.push({ field: 'Nombre', before: base.name, after: target.name });
  }
  if ((base.comment ?? '') !== (target.comment ?? '')) {
    changes.push({ field: 'Comentario', before: fmt(base.comment), after: fmt(target.comment) });
  }
  return changes;
}

/**
 * Empareja por pdId (estable entre ficheros), luego por code,
 * luego por name y al final por id (posicional, el peor caso).
 */
export function pairByCode<T extends { id: string; name: string; code?: string; pdId?: string }>(
  base: T[],
  target: T[],
): { baseOnly: T[]; targetOnly: T[]; paired: [T, T][] } {
  const targetByKey = new Map<string, T>();
  for (const item of target) {
    if (item.pdId) targetByKey.set(`pdid:${item.pdId.trim().toLowerCase()}`, item);
    if (item.code) targetByKey.set(`code:${item.code.toLowerCase()}`, item);
    targetByKey.set(`name:${item.name.toLowerCase()}`, item);
    targetByKey.set(`id:${item.id}`, item);
  }

  const usedTargetIds = new Set<string>();
  const paired: [T, T][] = [];
  const baseOnly: T[] = [];

  for (const item of base) {
    const match =
      (item.pdId ? targetByKey.get(`pdid:${item.pdId.trim().toLowerCase()}`) : undefined) ??
      (item.code ? targetByKey.get(`code:${item.code.toLowerCase()}`) : undefined) ??
      targetByKey.get(`name:${item.name.toLowerCase()}`) ??
      targetByKey.get(`id:${item.id}`);

    if (match && !usedTargetIds.has(match.id)) {
      usedTargetIds.add(match.id);
      paired.push([item, match]);
    } else {
      baseOnly.push(item);
    }
  }

  const targetOnly = target.filter((item) => !usedTargetIds.has(item.id));
  return { baseOnly, targetOnly, paired };
}

function diffCollection<T extends { id: string; name: string; code?: string }>(
  base: T[],
  target: T[],
  parentLabel: string | undefined,
  diffFn: (a: T, b: T) => FieldChange[],
  nameFn?: (item: T) => string,
): ObjectDiff[] {
  const { baseOnly, targetOnly, paired } = pairByCode(base, target);
  const results: ObjectDiff[] = [];

  for (const item of targetOnly) {
    results.push({
      kind: 'added',
      id: item.id,
      name: nameFn ? nameFn(item) : item.name,
      parent: parentLabel,
      changes: [],
    });
  }

  for (const item of baseOnly) {
    results.push({
      kind: 'removed',
      id: item.id,
      name: nameFn ? nameFn(item) : item.name,
      parent: parentLabel,
      changes: [],
    });
  }

  for (const [a, b] of paired) {
    const changes = diffFn(a, b);
    if (changes.length > 0) {
      results.push({
        kind: 'modified',
        id: b.id,
        name: nameFn ? nameFn(b) : b.name,
        parent: parentLabel,
        changes,
      });
    }
  }

  return results;
}

export function diffModels(base: Model, target: Model): ModelDiff {
  const tables = diffCollection(base.tables, target.tables, undefined, diffTable);

  // Parear tablas para comparar sus columnas, índices y claves internas.
  const { paired: pairedTables } = pairByCode(base.tables, target.tables);

  const columns: ObjectDiff[] = [];
  const indexes: ObjectDiff[] = [];
  const keys: ObjectDiff[] = [];

  for (const [baseTable, targetTable] of pairedTables) {
    columns.push(
      ...diffCollection(
        baseTable.columns,
        targetTable.columns,
        targetTable.name,
        diffColumn,
        (col) => col.name,
      ),
    );
    indexes.push(
      ...diffCollection(
        baseTable.indexes,
        targetTable.indexes,
        targetTable.name,
        diffIndex,
        (idx) => idx.name,
      ),
    );
    keys.push(
      ...diffCollection(
        baseTable.keys,
        targetTable.keys,
        targetTable.name,
        diffKey,
        (key) => key.name,
      ),
    );
  }

  const references = diffCollection(
    base.references,
    target.references,
    undefined,
    diffReference,
    (ref) => ref.name || ref.id,
  );

  const all = [...tables, ...columns, ...references, ...indexes, ...keys];
  const summary = {
    added: all.filter((d) => d.kind === 'added').length,
    removed: all.filter((d) => d.kind === 'removed').length,
    modified: all.filter((d) => d.kind === 'modified').length,
    total: all.length,
  };

  return { tables, columns, references, indexes, keys, summary };
}

/** Genera sentencias ALTER TABLE a partir de un diff de columnas. */
export function generateAlterSql(diff: ModelDiff, target: Model): string[] {
  const statements: string[] = [];
  const tableById = new Map(target.tables.map((t) => [t.id, t]));
  const tableByCode = new Map(target.tables.map((t) => [t.code.toLowerCase(), t]));

  // Tablas añadidas
  for (const item of diff.tables) {
    if (item.kind !== 'added') continue;
    const table = target.tables.find((t) => t.id === item.id);
    if (!table) continue;
    statements.push(`-- Nueva tabla: ${table.code}`);
    statements.push(`CREATE TABLE ${table.code} (`);
    const cols = table.columns.map(
      (col) =>
        `  ${col.code} ${col.dataType}${col.length ? `(${col.length})` : ''}${col.mandatory ? ' NOT NULL' : ''}`,
    );
    statements.push(cols.join(',\n'));
    statements.push(');');
    statements.push('');
  }

  // Columnas modificadas
  for (const item of diff.columns) {
    if (item.kind !== 'modified') continue;
    const table =
      (item.parent && tableByCode.get(item.parent.toLowerCase())) ||
      tableById.get(item.parent ?? '');
    if (!table) continue;

    for (const change of item.changes) {
      if (change.field === 'Tipo') {
        statements.push(`ALTER TABLE ${table.code} MODIFY (${item.name} ${change.after});`);
      } else if (change.field === 'Longitud') {
        statements.push(`ALTER TABLE ${table.code} MODIFY (${item.name} ${change.after});`);
      } else if (change.field === 'Nullable') {
        if (change.after === 'NOT NULL') {
          statements.push(`ALTER TABLE ${table.code} MODIFY (${item.name} NOT NULL);`);
        } else {
          statements.push(`ALTER TABLE ${table.code} MODIFY (${item.name} NULL);`);
        }
      }
    }
  }

  // Columnas añadidas
  for (const item of diff.columns) {
    if (item.kind !== 'added') continue;
    const table =
      (item.parent && tableByCode.get(item.parent.toLowerCase())) ||
      tableById.get(item.parent ?? '');
    if (!table) continue;
    const col = table.columns.find((c) => c.id === item.id);
    if (!col) continue;
    statements.push(
      `ALTER TABLE ${table.code} ADD (${col.code} ${col.dataType}${col.length ? `(${col.length})` : ''}${col.mandatory ? ' NOT NULL' : ''});`,
    );
  }

  // Columnas eliminadas
  for (const item of diff.columns) {
    if (item.kind !== 'removed') continue;
    const table =
      (item.parent && tableByCode.get(item.parent.toLowerCase())) ||
      tableById.get(item.parent ?? '');
    if (!table) continue;
    statements.push(`ALTER TABLE ${table.code} DROP COLUMN ${item.name};`);
  }

  // Tablas eliminadas
  for (const item of diff.tables) {
    if (item.kind !== 'removed') continue;
    statements.push(`DROP TABLE ${item.name};`);
  }

  return statements;
}
