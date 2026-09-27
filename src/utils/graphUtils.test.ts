import { describe, expect, it } from 'vitest';
import type { Model, Table, Reference } from '../model/types';
import {
  buildAdjacency,
  directNeighbors,
  neighborsWithinHops,
  shortestPath,
  pathEdgeIds,
  findFkCycles,
  computeSemanticFlags,
  relationCounts,
  heatValues,
  heatClass,
  groupByPrefix,
} from './graphUtils';

function makeTable(id: string, opts: Partial<Table> = {}): Table {
  return {
    id,
    code: id,
    name: id,
    columns: opts.columns ?? [
      { id: `${id}_pk`, code: 'id', name: 'id', dataType: 'INTEGER', mandatory: true, identity: true },
      { id: `${id}_fk`, code: 'ref_id', name: 'ref_id', dataType: 'INTEGER', mandatory: false, identity: false },
    ],
    keys: opts.keys ?? [],
    indexes: opts.indexes ?? [],
    primaryKey: opts.primaryKey,
    ...opts,
  };
}

function makeRef(id: string, parent: string, child: string): Reference {
  return {
    id,
    name: id,
    parentTable: parent,
    childTable: child,
    joins: [{ parentColumn: `${parent}_pk`, childColumn: `${child}_fk` }],
    cardinality: '1:N',
  };
}

function makeModel(tables: Table[], references: Reference[]): Model {
  return { name: 'test', tables, references, domains: [] };
}

describe('buildAdjacency', () => {
  it('crea aristas en ambos sentidos', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b')],
      [makeRef('r1', 'a', 'b')],
    );
    const adj = buildAdjacency(model);
    expect(adj.get('a')).toEqual(new Set(['b']));
    expect(adj.get('b')).toEqual(new Set(['a']));
  });

  it('incluye tablas aisladas', () => {
    const model = makeModel([makeTable('a'), makeTable('b')], []);
    const adj = buildAdjacency(model);
    expect(adj.get('a')).toEqual(new Set());
    expect(adj.has('b')).toBe(true);
  });
});

describe('directNeighbors', () => {
  it('devuelve vecinos directos', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b'), makeTable('c')],
      [makeRef('r1', 'a', 'b'), makeRef('r2', 'a', 'c')],
    );
    expect(directNeighbors(model, 'a')).toEqual(new Set(['b', 'c']));
    expect(directNeighbors(model, 'b')).toEqual(new Set(['a']));
    expect(directNeighbors(model, 'c')).toEqual(new Set(['a']));
  });
});

describe('neighborsWithinHops', () => {
  it('cadena a-b-c: 1 salto desde a solo ve b', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b'), makeTable('c')],
      [makeRef('r1', 'a', 'b'), makeRef('r2', 'b', 'c')],
    );
    expect(neighborsWithinHops(model, 'a', 1)).toEqual(new Set(['b']));
    expect(neighborsWithinHops(model, 'a', 2)).toEqual(new Set(['b', 'c']));
  });

  it('0 saltos devuelve vacío', () => {
    const model = makeModel([makeTable('a'), makeTable('b')], [makeRef('r1', 'a', 'b')]);
    expect(neighborsWithinHops(model, 'a', 0)).toEqual(new Set());
  });
});

describe('shortestPath', () => {
  it('encuentra el camino más corto', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b'), makeTable('c')],
      [makeRef('r1', 'a', 'b'), makeRef('r2', 'b', 'c')],
    );
    expect(shortestPath(model, 'a', 'c')).toEqual(['a', 'b', 'c']);
  });

  it('elige el camino corto frente al largo', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b'), makeTable('c'), makeTable('d')],
      [
        makeRef('r1', 'a', 'b'),
        makeRef('r2', 'b', 'c'),
        makeRef('r3', 'c', 'd'),
        makeRef('r4', 'a', 'd'),
      ],
    );
    expect(shortestPath(model, 'a', 'd')).toEqual(['a', 'd']);
  });

  it('devuelve null si no hay camino', () => {
    const model = makeModel([makeTable('a'), makeTable('b')], []);
    expect(shortestPath(model, 'a', 'b')).toBeNull();
  });

  it('misma tabla devuelve ella sola', () => {
    const model = makeModel([makeTable('a')], []);
    expect(shortestPath(model, 'a', 'a')).toEqual(['a']);
  });
});

describe('pathEdgeIds', () => {
  it('identifica las aristas del camino', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b'), makeTable('c')],
      [makeRef('r1', 'a', 'b'), makeRef('r2', 'b', 'c'), makeRef('r3', 'a', 'c')],
    );
    const edges = pathEdgeIds(model, ['a', 'b', 'c']);
    expect(edges.has('r1')).toBe(true);
    expect(edges.has('r2')).toBe(true);
    expect(edges.has('r3')).toBe(false);
  });
});

describe('findFkCycles', () => {
  it('detecta un ciclo simple', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b')],
      [makeRef('r1', 'a', 'b'), makeRef('r2', 'b', 'a')],
    );
    const cycles = findFkCycles(model);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const flat = cycles.flat();
    expect(flat).toContain('a');
    expect(flat).toContain('b');
  });

  it('grafo sin ciclos no devuelve nada', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b'), makeTable('c')],
      [makeRef('r1', 'a', 'b'), makeRef('r2', 'b', 'c')],
    );
    expect(findFkCycles(model)).toHaveLength(0);
  });
});

describe('computeSemanticFlags', () => {
  it('marca tabla sin PK', () => {
    const table = makeTable('a', { primaryKey: [] });
    const model = makeModel([table], []);
    const flags = computeSemanticFlags(model);
    expect(flags.noPk.has('a')).toBe(true);
  });

  it('marca tabla huérfana', () => {
    const model = makeModel([makeTable('a'), makeTable('b')], []);
    const flags = computeSemanticFlags(model);
    expect(flags.orphan.has('a')).toBe(true);
    expect(flags.orphan.has('b')).toBe(true);
  });

  it('no marca como huérfana si tiene relaciones', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b')],
      [makeRef('r1', 'a', 'b')],
    );
    const flags = computeSemanticFlags(model);
    expect(flags.orphan.has('a')).toBe(false);
  });

  it('marca FK sin índice', () => {
    const model = makeModel(
      [makeTable('a', { primaryKey: ['a_pk'] }), makeTable('b', { primaryKey: ['b_pk'] })],
      [makeRef('r1', 'a', 'b')],
    );
    const flags = computeSemanticFlags(model);
    expect(flags.fkNoIndex.has('b')).toBe(true);
    expect(flags.fkNoIndex.has('a')).toBe(false);
  });

  it('marca PK nullable', () => {
    const table = makeTable('a', {
      primaryKey: ['a_fk'],
      columns: [
        { id: 'a_fk', code: 'ref', name: 'ref', dataType: 'INT', mandatory: false, identity: false },
      ],
    });
    const model = makeModel([table], []);
    const flags = computeSemanticFlags(model);
    expect(flags.nullableKey.has('a')).toBe(true);
  });
});

describe('relationCounts', () => {
  it('cuenta relaciones por tabla', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b'), makeTable('c')],
      [makeRef('r1', 'a', 'b'), makeRef('r2', 'a', 'c')],
    );
    const counts = relationCounts(model);
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBe(1);
  });
});

describe('heatValues', () => {
  it('métrica columns', () => {
    const model = makeModel(
      [
        makeTable('a', { columns: [{ id: 'x', code: 'x', name: 'x', dataType: 'INT', mandatory: true, identity: false }] }),
        makeTable('b'),
      ],
      [],
    );
    const values = heatValues(model, 'columns');
    expect(values.get('a')).toBe(1);
    expect(values.get('b')).toBe(2);
  });

  it('métrica relations usa el grado', () => {
    const model = makeModel(
      [makeTable('a'), makeTable('b')],
      [makeRef('r1', 'a', 'b')],
    );
    const values = heatValues(model, 'relations');
    expect(values.get('a')).toBe(1);
  });
});

describe('heatClass', () => {
  it('devuelve 0..3', () => {
    expect(heatClass(0, 0, 10)).toBe(0);
    expect(heatClass(2, 0, 10)).toBe(0);
    expect(heatClass(3, 0, 10)).toBe(1);
    expect(heatClass(4, 0, 10)).toBe(1);
    expect(heatClass(5, 0, 10)).toBe(2);
    expect(heatClass(7, 0, 10)).toBe(2);
    expect(heatClass(8, 0, 10)).toBe(3);
    expect(heatClass(10, 0, 10)).toBe(3);
  });

  it('rango plano devuelve 0', () => {
    expect(heatClass(5, 5, 5)).toBe(0);
  });
});

describe('groupByPrefix', () => {
  it('agrupa por prefijo antes del guion bajo', () => {
    const tables = [makeTable('crm_clientes'), makeTable('crm_cuentas'), makeTable('fin_facturas')];
    const groups = groupByPrefix(tables);
    expect(groups.get('crm')).toHaveLength(2);
    expect(groups.get('fin')).toHaveLength(1);
  });

  it('tablas sin guion van a (sin prefijo)', () => {
    const groups = groupByPrefix([makeTable('usuarios')]);
    expect(groups.get('(sin prefijo)')).toHaveLength(1);
  });
});
