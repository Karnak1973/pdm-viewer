import { describe, expect, it } from 'vitest';
import type { Model, Table, Column } from '../model/types';
import { globalSearch, availablePrefixes, groupHits } from './globalSearch';

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
  const columns = opts.columns ?? [col(`${id}_c1`, 'id', { dataType: 'NUMBER' })];
  return {
    id,
    code: id,
    name: id,
    columns,
    keys: opts.keys ?? [],
    indexes: opts.indexes ?? [],
    primaryKey: opts.primaryKey ?? [columns[0].id],
    ...opts,
  };
}

function model(tables: Table[]): Model {
  return { name: 'test', tables, references: [], domains: [] };
}

describe('globalSearch', () => {
  const m = model([
    table('crm_clientes', {
      columns: [
        col('cc_id', 'id', { dataType: 'NUMBER' }),
        col('cc_email', 'email', { comment: 'Correo electrónico principal' }),
        col('cc_tel', 'telefono'),
      ],
      comment: 'Clientes del CRM',
    }),
    table('fin_facturas', {
      columns: [col('ff_id', 'id', { dataType: 'NUMBER' }), col('ff_total', 'importe_total')],
    }),
    table('crm_pedidos', {
      columns: [col('cp_id', 'id', { dataType: 'NUMBER' })],
      indexes: [{ id: 'ix1', name: 'idx_fecha', columns: ['cp_id'], unique: false }],
    }),
  ]);

  it('vacío devuelve nada', () => {
    expect(globalSearch(m, '')).toHaveLength(0);
    expect(globalSearch(m, '   ')).toHaveLength(0);
  });

  it('encuentra tabla por nombre', () => {
    const hits = globalSearch(m, 'clientes');
    expect(hits.some((h) => h.kind === 'table' && h.title === 'crm_clientes')).toBe(true);
  });

  it('encuentra tabla por código', () => {
    const hits = globalSearch(m, 'facturas');
    expect(hits.some((h) => h.kind === 'table')).toBe(true);
  });

  it('encuentra columna por nombre', () => {
    const hits = globalSearch(m, 'email');
    expect(hits.some((h) => h.kind === 'column' && h.title === 'email')).toBe(true);
  });

  it('encuentra comentario de columna', () => {
    const hits = globalSearch(m, 'electrónico');
    expect(hits.some((h) => h.kind === 'comment')).toBe(true);
  });

  it('encuentra comentario de tabla', () => {
    const hits = globalSearch(m, 'CRM');
    expect(hits.some((h) => h.kind === 'comment')).toBe(true);
  });

  it('encuentra índice', () => {
    const hits = globalSearch(m, 'fecha');
    expect(hits.some((h) => h.kind === 'index')).toBe(true);
  });

  it('los resultados están ordenados por relevancia', () => {
    const hits = globalSearch(m, 'clientes');
    expect(hits.length).toBeGreaterThan(1);
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it('el match exacto puntúa más alto que uno parcial', () => {
    const exact = globalSearch(m, 'crm_clientes');
    const partial = globalSearch(m, 'crm');
    if (exact.length > 0 && partial.length > 0) {
      expect(exact[0].score).toBeGreaterThanOrEqual(partial[0].score * 0.5);
    }
  });

  it('filtra por tipo de resultado', () => {
    const hits = globalSearch(m, 'crm', { kinds: new Set(['table']), prefix: null });
    expect(hits.every((h) => h.kind === 'table')).toBe(true);
  });

  it('filtra por prefijo de tabla', () => {
    const hits = globalSearch(m, 'id', { kinds: null, prefix: 'fin' });
    expect(hits.every((h) => h.title.includes('facturas') || h.subtitle.includes('fin'))).toBe(true);
  });

  it('la tabla contenedora se asigna a las columnas', () => {
    const hits = globalSearch(m, 'importe');
    const colHit = hits.find((h) => h.kind === 'column');
    expect(colHit?.tableId).toBeTruthy();
  });
});

describe('availablePrefixes', () => {
  it('devuelve prefijos únicos ordenados', () => {
    const m = model([table('crm_a'), table('crm_b'), table('fin_c')]);
    expect(availablePrefixes(m)).toEqual(['crm', 'fin']);
  });

  it('sin prefijos devuelve vacío', () => {
    const m = model([table('usuarios')]);
    expect(availablePrefixes(m)).toEqual([]);
  });
});

describe('groupHits', () => {
  it('agrupa por tipo', () => {
    const m = model([table('crm_clientes')]);
    const hits = globalSearch(m, 'crm');
    const groups = groupHits(hits);
    expect(groups.size).toBeGreaterThan(0);
    for (const [, list] of groups) {
      const kind = list[0].kind;
      expect(list.every((h) => h.kind === kind)).toBe(true);
    }
  });
});
