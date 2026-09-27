import { describe, expect, it } from 'vitest';
import type { Table } from '../model/types';
import { buildTableEdits, isTableDraftValid, toTableDraft } from './pdmEdits';

const table: Table = {
  id: 'table-0',
  pdId: 'o9',
  code: 'Table_1',
  name: 'Table_1',
  comment: 'Original',
  columns: [
    {
      id: 'column-0',
      pdId: 'o12',
      code: 'Column_1',
      name: 'Column_1',
      dataType: 'INT8',
      length: 8,
      mandatory: true,
      identity: false,
    },
    {
      id: 'column-1',
      pdId: 'o13',
      code: 'Column_2',
      name: 'Column_2',
      dataType: 'FLOAT8',
      mandatory: false,
      identity: false,
      comment: 'Sin longitud',
    },
  ],
  primaryKey: ['column-0'],
  keys: [],
  indexes: [],
};

describe('toTableDraft', () => {
  it('copia todos los campos editables', () => {
    const draft = toTableDraft(table);
    expect(draft).toEqual({
      name: 'Table_1',
      code: 'Table_1',
      comment: 'Original',
      columns: [
        {
          pdId: 'o12',
          code: 'Column_1',
          name: 'Column_1',
          dataType: 'INT8',
          length: '8',
          comment: '',
          mandatory: true,
        },
        {
          pdId: 'o13',
          code: 'Column_2',
          name: 'Column_2',
          dataType: 'FLOAT8',
          length: '',
          comment: 'Sin longitud',
          mandatory: false,
        },
      ],
    });
  });
});

describe('buildTableEdits', () => {
  it('no genera ediciones si nada cambia', () => {
    expect(buildTableEdits(table, toTableDraft(table))).toEqual([]);
  });

  it('genera una sola edición al renombrar la tabla', () => {
    const draft = { ...toTableDraft(table), name: 'Clientes' };
    expect(buildTableEdits(table, draft)).toEqual([
      { element: 'o:Table', pdId: 'o9', child: 'a:Name', value: 'Clientes' },
    ]);
  });

  it('elimina el comentario cuando se vacía', () => {
    const draft = { ...toTableDraft(table), comment: '' };
    expect(buildTableEdits(table, draft)).toEqual([
      { element: 'o:Table', pdId: 'o9', child: 'a:Comment', value: null },
    ]);
  });

  it('detecta cambio de tipo de dato', () => {
    const draft = toTableDraft(table);
    draft.columns[1].dataType = 'VARCHAR';
    expect(buildTableEdits(table, draft)).toEqual([
      { element: 'o:Column', pdId: 'o13', child: 'a:DataType', value: 'VARCHAR' },
    ]);
  });

  it('detecta cambio de longitud', () => {
    const draft = toTableDraft(table);
    draft.columns[0].length = '32';
    expect(buildTableEdits(table, draft)).toEqual([
      { element: 'o:Column', pdId: 'o12', child: 'a:Length', value: 32 },
    ]);
  });

  it('elimina la longitud al vaciarla', () => {
    const draft = toTableDraft(table);
    draft.columns[0].length = '';
    expect(buildTableEdits(table, draft)).toEqual([
      { element: 'o:Column', pdId: 'o12', child: 'a:Length', value: null },
    ]);
  });

  it('añade la longitud que faltaba', () => {
    const draft = toTableDraft(table);
    draft.columns[1].length = '18';
    expect(buildTableEdits(table, draft)).toEqual([
      { element: 'o:Column', pdId: 'o13', child: 'a:Length', value: 18 },
    ]);
  });

  it('alterna NOT NULL', () => {
    const draft = toTableDraft(table);
    draft.columns[0].mandatory = false;
    draft.columns[1].mandatory = true;
    expect(buildTableEdits(table, draft)).toEqual([
      { element: 'o:Column', pdId: 'o12', child: 'a:Column.Mandatory', value: false },
      { element: 'o:Column', pdId: 'o13', child: 'a:Column.Mandatory', value: true },
    ]);
  });

  it('ignora columnas sin id de PowerDesigner', () => {
    const draft = toTableDraft(table);
    draft.columns[1].pdId = undefined;
    draft.columns[1].dataType = 'VARCHAR';
    expect(buildTableEdits(table, draft)).toEqual([]);
  });

  it('devuelve vacío si la tabla no tiene pdId', () => {
    const draft = { ...toTableDraft(table), name: 'Otra' };
    expect(buildTableEdits({ ...table, pdId: undefined }, draft)).toEqual([]);
  });
});

describe('isTableDraftValid', () => {
  it('acepta el borrador original', () => {
    expect(isTableDraftValid(toTableDraft(table))).toBe(true);
  });

  it('rechaza nombre o código de tabla vacíos', () => {
    expect(isTableDraftValid({ ...toTableDraft(table), name: '  ' })).toBe(false);
    expect(isTableDraftValid({ ...toTableDraft(table), code: '' })).toBe(false);
  });

  it('rechaza columnas incompletas', () => {
    const draft = toTableDraft(table);
    draft.columns[0].dataType = ' ';
    expect(isTableDraftValid(draft)).toBe(false);
  });
});
