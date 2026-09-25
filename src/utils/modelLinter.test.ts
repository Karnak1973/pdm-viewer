import { describe, expect, it } from 'vitest';
import type { Model, Table } from '../model/types';
import { lintModel } from './modelLinter';
import { createDemoModel } from './sampleModel';

function baseTable(overrides: Partial<Table> = {}): Table {
  return {
    id: 't1',
    code: 'Entity',
    name: 'Entity',
    columns: [
      { id: 'c1', code: 'EntityID', name: 'EntityID', dataType: 'INTEGER', mandatory: true, identity: true },
      { id: 'c2', code: 'Label', name: 'Label', dataType: 'VARCHAR', length: 100, mandatory: false, identity: false },
    ],
    primaryKey: ['c1'],
    keys: [{ id: 'k1', name: 'PK_Entity', columns: ['c1'], isPrimary: true }],
    indexes: [],
    ...overrides,
  };
}

function modelWith(tables: Table[], references: Model['references'] = []): Model {
  return { name: 'Test', tables, references, domains: [] };
}

describe('lintModel', () => {
  it('no reporta errores en el modelo de ejemplo', () => {
    const report = lintModel(createDemoModel());
    expect(report.counts.error).toBe(0);
    expect(report.score).toBeGreaterThanOrEqual(95);
  });

  it('penaliza tablas sin clave primaria', () => {
    const table = baseTable({ primaryKey: [], keys: [] });
    const report = lintModel(modelWith([table]));
    const issue = report.issues.find((candidate) => candidate.title === 'Tabla sin clave primaria');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('detecta claves primarias anulables', () => {
    const table = baseTable();
    table.columns[0].mandatory = false;
    const report = lintModel(modelWith([table]));
    const issue = report.issues.find((candidate) => candidate.title === 'Clave primaria anulable');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('detecta columnas duplicadas dentro de una tabla', () => {
    const table = baseTable();
    table.columns.push({
      id: 'c3',
      code: 'Label',
      name: 'Label',
      dataType: 'VARCHAR',
      length: 50,
      mandatory: false,
      identity: false,
    });
    const report = lintModel(modelWith([table]));
    expect(report.issues.some((issue) => issue.title === 'Columna duplicada')).toBe(true);
  });

  it('detecta columnas identidad en tipos no numéricos', () => {
    const table = baseTable();
    table.columns[1].identity = true;
    const report = lintModel(modelWith([table]));
    const issue = report.issues.find((candidate) => candidate.title === 'Identity en columna no numérica');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('marca claves foráneas sin índice', () => {
    const parent = baseTable({ id: 'parent', code: 'Parent', name: 'Parent' });
    const child = baseTable({ id: 'child', code: 'Child', name: 'Child' });
    child.columns.push({
      id: 'c9',
      code: 'ParentID',
      name: 'ParentID',
      dataType: 'INTEGER',
      mandatory: true,
      identity: false,
    });

    const report = lintModel(
      modelWith([parent, child], [
        {
          id: 'r1',
          name: 'FK_Child_Parent',
          parentTable: 'parent',
          childTable: 'child',
          joins: [{ parentColumn: 'c1', childColumn: 'c9' }],
          cardinality: '1:N',
        },
      ]),
    );

    expect(report.issues.some((issue) => issue.title === 'Clave foránea sin índice')).toBe(true);
  });

  it('no marca la clave foránea si existe un índice que la cubre', () => {
    const parent = baseTable({ id: 'parent', code: 'Parent', name: 'Parent' });
    const child = baseTable({
      id: 'child',
      code: 'Child',
      name: 'Child',
      indexes: [{ id: 'i1', name: 'IX_Child_ParentID', columns: ['c9'], unique: false }],
    });
    child.columns.push({
      id: 'c9',
      code: 'ParentID',
      name: 'ParentID',
      dataType: 'INTEGER',
      mandatory: true,
      identity: false,
    });

    const report = lintModel(
      modelWith([parent, child], [
        {
          id: 'r1',
          name: 'FK_Child_Parent',
          parentTable: 'parent',
          childTable: 'child',
          joins: [{ parentColumn: 'c1', childColumn: 'c9' }],
          cardinality: '1:N',
        },
      ]),
    );

    expect(report.issues.some((issue) => issue.title === 'Clave foránea sin índice')).toBe(false);
  });

  it('detecta referencias a tablas inexistentes', () => {
    const report = lintModel(
      modelWith([baseTable()], [
        {
          id: 'r1',
          name: 'FK_Rota',
          parentTable: 'no-existe',
          childTable: 't1',
          joins: [],
          cardinality: '1:N',
        },
      ]),
    );
    expect(report.issues.some((issue) => issue.title === 'Relación huérfana')).toBe(true);
  });

  it('avisa de relaciones N:M sin resolver', () => {
    const a = baseTable({ id: 'a', code: 'Alpha' });
    const b = baseTable({ id: 'b', code: 'Beta' });
    const report = lintModel(
      modelWith([a, b], [
        {
          id: 'r1',
          name: 'Rel_Alpha_Beta',
          parentTable: 'a',
          childTable: 'b',
          joins: [{ parentColumn: 'c1', childColumn: 'c1' }],
          cardinality: 'N:M',
        },
      ]),
    );
    expect(report.issues.some((issue) => issue.title === 'Relación N:M sin resolver')).toBe(true);
  });

  it('avisa de VARCHAR2 por encima del máximo de Oracle', () => {
    const table = baseTable();
    table.columns[1].length = 8000;
    const report = lintModel(modelWith([table]));
    expect(report.issues.some((issue) => issue.title === 'VARCHAR2 fuera de rango')).toBe(true);
  });

  it('detecta índices redundantes', () => {
    const table = baseTable({
      indexes: [
        { id: 'i1', name: 'IX_A', columns: ['c2'], unique: false },
        { id: 'i2', name: 'IX_B', columns: ['c2'], unique: true },
      ],
    });
    const report = lintModel(modelWith([table]));
    expect(report.issues.some((issue) => issue.title === 'Índices duplicados')).toBe(true);
  });

  it('baja la puntuación a medida que aparecen problemas', () => {
    const clean = lintModel(createDemoModel());
    const dirty = lintModel(
      modelWith([
        baseTable({ primaryKey: [], keys: [] }),
        baseTable({ id: 't2', code: 'Other', primaryKey: [], keys: [] }),
      ]),
    );
    expect(dirty.score).toBeLessThan(clean.score);
    expect(dirty.score).toBeGreaterThanOrEqual(0);
  });

  it('mantiene la puntuación entre 0 y 100', () => {
    const tables = Array.from({ length: 8 }, (_, index) =>
      baseTable({ id: `t${index}`, code: `Table${index}`, primaryKey: [], keys: [] }),
    );
    const report = lintModel(modelWith(tables));
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });
});
