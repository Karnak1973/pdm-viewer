import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePowerDesignerXml } from './xmlParser';
import { normalizeModel } from './normalizer';

const exampleXml = readFileSync(new URL('../../examples/example.pdm', import.meta.url), 'utf8');
const model = normalizeModel(parsePowerDesignerXml(exampleXml), 'example');

function tableByCode(code: string) {
  const table = model.tables.find((entry) => entry.code === code);
  if (!table) throw new Error(`Tabla no encontrada: ${code}`);
  return table;
}

describe('normalizeModel con un .pdm real de PowerDesigner', () => {
  it('extrae las dos tablas con sus columnas', () => {
    expect(model.tables).toHaveLength(2);
    expect(model.tables.map((table) => table.code)).toEqual(['Table_1', 'Table_2']);
    expect(tableByCode('Table_1').columns.map((column) => column.code)).toEqual([
      'Column_1',
      'Column_2',
    ]);
  });

  it('asigna ids sintéticos únicos entre tablas', () => {
    const ids = model.tables.flatMap((table) => table.columns.map((column) => column.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lee Column.Mandatory como NOT NULL', () => {
    const table = tableByCode('Table_1');
    expect(table.columns[0].mandatory).toBe(true);
    expect(table.columns[1].mandatory).toBe(false);
    expect(tableByCode('Table_2').columns[0].mandatory).toBe(true);
  });

  it('resuelve la clave primaria declarada como Ref de Key', () => {
    const table = tableByCode('Table_1');
    expect(table.primaryKey).toEqual([table.columns[0].id]);
    expect(table.keys.some((key) => key.isPrimary)).toBe(true);
    expect(table.keys[0].columns).toEqual([table.columns[0].id]);
    expect(table.keys[0].pdId).toBe('o14');
  });

  it('resuelve las columnas del índice desde IndexColumn.Expression', () => {
    const table = tableByCode('Table_1');
    expect(table.indexes).toHaveLength(1);
    expect(table.indexes[0].unique).toBe(true);
    expect(table.indexes[0].columns).toEqual([table.columns[1].id]);
    expect(table.indexes[0].pdId).toBe('o15');
  });

  it('resuelve el padre y el hijo de la referencia mediante Ref', () => {
    expect(model.references).toHaveLength(1);
    const reference = model.references[0];
    expect(reference.parentTable).toBe(tableByCode('Table_1').id);
    expect(reference.childTable).toBe(tableByCode('Table_2').id);
    expect(reference.cardinality).toBe('0..*');
    expect(reference.pdId).toBe('o8');
  });

  it('lee los joins desde ReferenceJoin Object1/Object2', () => {
    const reference = model.references[0];
    const parent = tableByCode('Table_1');
    const child = tableByCode('Table_2');
    expect(reference.joins).toHaveLength(1);
    expect(reference.joins[0].parentColumn).toBe(parent.columns[0].id);
    expect(reference.joins[0].childColumn).toBe(child.columns[1].id);
  });

  it('traduce las restricciones numéricas a texto legible', () => {
    expect(model.references[0].onDelete).toBe('Restrict');
    expect(model.references[0].onUpdate).toBe('Restrict');
  });

  it('lee las posiciones del diagrama desde a:Rect', () => {
    for (const table of model.tables) {
      expect(table.position).toBeDefined();
      expect(table.position!.w).toBeGreaterThan(100);
      expect(table.position!.w).toBeLessThan(500);
    }
    expect(tableByCode('Table_1').position!.x).toBeLessThan(
      tableByCode('Table_2').position!.x,
    );
  });

  it('conserva el id de objeto de PowerDesigner para cada entidad', () => {
    expect(tableByCode('Table_1').pdId).toBe('o9');
    expect(tableByCode('Table_2').pdId).toBe('o10');
    expect(tableByCode('Table_1').columns[0].pdId).toBe('o12');
    expect(tableByCode('Table_2').columns[1].pdId).toBe('o18');
  });
});
