import { describe, expect, it } from 'vitest';
import type { Model, Table, Column, Reference } from '../model/types';
import { diffModels, generateAlterSql } from './modelDiff';

function col(id: string, code: string, opts: Partial<Column> = {}): Column {
  return {
    id,
    code,
    name: code,
    dataType: 'VARCHAR2',
    length: 50,
    mandatory: true,
    identity: false,
    ...opts,
  };
}

function table(id: string, opts: Partial<Table> = {}): Table {
  const columns = opts.columns ?? [col(`${id}_c1`, 'id', { dataType: 'NUMBER', length: undefined, identity: true })];
  return {
    id,
    code: id,
    name: id,
    columns,
    keys: [],
    indexes: [],
    primaryKey: opts.primaryKey ?? [columns[0]?.id].filter(Boolean) as string[],
    ...opts,
  };
}

function ref(id: string, parent: string, child: string): Reference {
  return {
    id,
    name: id,
    parentTable: parent,
    childTable: child,
    joins: [{ parentColumn: 'a', childColumn: 'b' }],
    cardinality: '1:N',
  };
}

function model(tables: Table[], references: Reference[] = []): Model {
  return { name: 'm', tables, references, domains: [] };
}

describe('diffModels — tablas', () => {
  it('detecta tabla añadida', () => {
    const base = model([table('a')]);
    const target = model([table('a'), table('b')]);
    const diff = diffModels(base, target);
    expect(diff.tables).toHaveLength(1);
    expect(diff.tables[0].kind).toBe('added');
    expect(diff.tables[0].name).toBe('b');
    expect(diff.summary.added).toBe(1);
  });

  it('detecta tabla eliminada', () => {
    const base = model([table('a'), table('b')]);
    const target = model([table('a')]);
    const diff = diffModels(base, target);
    expect(diff.tables).toHaveLength(1);
    expect(diff.tables[0].kind).toBe('removed');
  });

  it('modelos idénticos no generan cambios', () => {
    const m = model([table('a'), table('b')]);
    const diff = diffModels(m, m);
    expect(diff.summary.total).toBe(0);
  });
});

describe('diffModels — columnas', () => {
  it('detecta cambio de tipo', () => {
    const base = model([table('t', { columns: [col('c1', 'nombre', { dataType: 'VARCHAR2', length: 50 })] })]);
    const target = model([table('t', { columns: [col('c1', 'nombre', { dataType: 'VARCHAR2', length: 100 })] })]);
    const diff = diffModels(base, target);
    expect(diff.columns).toHaveLength(1);
    expect(diff.columns[0].kind).toBe('modified');
    expect(diff.columns[0].changes[0]).toEqual({ field: 'Longitud', before: '50', after: '100' });
  });

  it('detecta cambio de tipo de dato', () => {
    const base = model([table('t', { columns: [col('c1', 'precio', { dataType: 'FLOAT' })] })]);
    const target = model([table('t', { columns: [col('c1', 'precio', { dataType: 'NUMBER' })] })]);
    const diff = diffModels(base, target);
    expect(diff.columns[0].changes).toContainEqual({
      field: 'Tipo',
      before: 'FLOAT',
      after: 'NUMBER',
    });
  });

  it('detecta cambio de nullable', () => {
    const base = model([table('t', { columns: [col('c1', 'x', { mandatory: true })] })]);
    const target = model([table('t', { columns: [col('c1', 'x', { mandatory: false })] })]);
    const diff = diffModels(base, target);
    expect(diff.columns[0].changes).toContainEqual({
      field: 'Nullable',
      before: 'NOT NULL',
      after: 'NULL',
    });
  });

  it('detecta columna añadida', () => {
    const base = model([table('t', { columns: [col('c1', 'a')] })]);
    const target = model([table('t', { columns: [col('c1', 'a'), col('c2', 'b')] })]);
    const diff = diffModels(base, target);
    const added = diff.columns.filter((d) => d.kind === 'added');
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe('b');
    expect(added[0].parent).toBe('t');
  });

  it('detecta columna eliminada', () => {
    const base = model([table('t', { columns: [col('c1', 'a'), col('c2', 'b')] })]);
    const target = model([table('t', { columns: [col('c1', 'a')] })]);
    const diff = diffModels(base, target);
    const removed = diff.columns.filter((d) => d.kind === 'removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].name).toBe('b');
  });
});

describe('diffModels — relaciones', () => {
  it('detecta relación añadida', () => {
    const base = model([table('a'), table('b')]);
    const target = model([table('a'), table('b')], [ref('r1', 'a', 'b')]);
    const diff = diffModels(base, target);
    expect(diff.references).toHaveLength(1);
    expect(diff.references[0].kind).toBe('added');
  });

  it('detecta cambio de cardinalidad', () => {
    const r1 = ref('r1', 'a', 'b');
    const base = model([table('a'), table('b')], [r1]);
    const target = model([table('a'), table('b')], [{ ...r1, cardinality: 'N:M' }]);
    const diff = diffModels(base, target);
    expect(diff.references).toHaveLength(1);
    expect(diff.references[0].kind).toBe('modified');
    expect(diff.references[0].changes).toContainEqual({
      field: 'Cardinalidad',
      before: '1:N',
      after: 'N:M',
    });
  });
});

describe('diffModels — índices', () => {
  it('detecta índice añadido', () => {
    const base = model([table('t')]);
    const target = model([
      table('t', {
        columns: [col('c1', 'id')],
        indexes: [{ id: 'i1', name: 'idx_id', columns: ['c1'], unique: false }],
      }),
    ]);
    const diff = diffModels(base, target);
    const added = diff.indexes.filter((d) => d.kind === 'added');
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe('idx_id');
  });
});

describe('generateAlterSql', () => {
  it('genera CREATE TABLE para tablas añadidas', () => {
    const base = model([]);
    const target = model([table('nueva')]);
    const diff = diffModels(base, target);
    const sql = generateAlterSql(diff, target);
    expect(sql.join('\n')).toContain('CREATE TABLE nueva');
  });

  it('genera DROP TABLE para tablas eliminadas', () => {
    const base = model([table('vieja')]);
    const target = model([]);
    const diff = diffModels(base, target);
    const sql = generateAlterSql(diff, target);
    expect(sql.join('\n')).toContain('DROP TABLE vieja;');
  });

  it('genera ALTER TABLE MODIFY para cambio de tipo', () => {
    const base = model([table('t', { columns: [col('c1', 'precio', { dataType: 'FLOAT' })] })]);
    const target = model([table('t', { columns: [col('c1', 'precio', { dataType: 'NUMBER' })] })]);
    const diff = diffModels(base, target);
    const sql = generateAlterSql(diff, target);
    expect(sql.join('\n')).toContain('ALTER TABLE t MODIFY');
    expect(sql.join('\n')).toContain('NUMBER');
  });

  it('genera ALTER TABLE ADD para columna nueva', () => {
    const base = model([table('t', { columns: [col('c1', 'a')] })]);
    const target = model([table('t', { columns: [col('c1', 'a'), col('c2', 'b', { dataType: 'NUMBER' })] })]);
    const diff = diffModels(base, target);
    const sql = generateAlterSql(diff, target);
    expect(sql.join('\n')).toContain('ALTER TABLE t ADD');
    expect(sql.join('\n')).toContain('b NUMBER');
  });

  it('sin cambios devuelve array vacío', () => {
    const m = model([table('a')]);
    const diff = diffModels(m, m);
    expect(generateAlterSql(diff, m)).toHaveLength(0);
  });
});
