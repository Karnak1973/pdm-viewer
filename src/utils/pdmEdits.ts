import type { Table } from '../model/types';
import type { PdmEdit } from '../parser/xmlPatch';

export interface ColumnDraft {
  pdId?: string;
  code: string;
  name: string;
  dataType: string;
  length: string;
  comment: string;
  mandatory: boolean;
}

export interface TableDraft {
  name: string;
  code: string;
  comment: string;
  columns: ColumnDraft[];
}

function optional(value: string | undefined): string {
  return value ?? '';
}

function toColumnDraft(column: Table['columns'][number]): ColumnDraft {
  return {
    pdId: column.pdId,
    code: column.code,
    name: column.name,
    dataType: column.dataType,
    length: column.length == null ? '' : String(column.length),
    comment: optional(column.comment),
    mandatory: column.mandatory,
  };
}

export function toTableDraft(table: Table): TableDraft {
  return {
    name: table.name,
    code: table.code,
    comment: optional(table.comment),
    columns: table.columns.map(toColumnDraft),
  };
}

function parseLength(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

export function buildTableEdits(table: Table, draft: TableDraft): PdmEdit[] {
  if (!table.pdId) return [];

  const edits: PdmEdit[] = [];
  const tableId = table.pdId;

  if (draft.name !== table.name) {
    edits.push({ element: 'o:Table', pdId: tableId, child: 'a:Name', value: draft.name });
  }
  if (draft.code !== table.code) {
    edits.push({ element: 'o:Table', pdId: tableId, child: 'a:Code', value: draft.code });
  }
  if (draft.comment !== optional(table.comment)) {
    edits.push({
      element: 'o:Table',
      pdId: tableId,
      child: 'a:Comment',
      value: draft.comment === '' ? null : draft.comment,
    });
  }

  for (const column of draft.columns) {
    if (!column.pdId) continue;
    const source = table.columns.find((entry) => entry.pdId === column.pdId);
    if (!source) continue;

    const child: PdmEdit = { element: 'o:Column', pdId: column.pdId, child: '', value: null };

    if (column.name !== source.name) {
      edits.push({ ...child, child: 'a:Name', value: column.name });
    }
    if (column.code !== source.code) {
      edits.push({ ...child, child: 'a:Code', value: column.code });
    }
    if (column.dataType !== source.dataType) {
      edits.push({ ...child, child: 'a:DataType', value: column.dataType });
    }

    const nextLength = parseLength(column.length);
    if (nextLength !== source.length) {
      edits.push({ ...child, child: 'a:Length', value: nextLength ?? null });
    }

    if (column.mandatory !== source.mandatory) {
      edits.push({ ...child, child: 'a:Column.Mandatory', value: column.mandatory });
    }

    if (column.comment !== optional(source.comment)) {
      edits.push({ ...child, child: 'a:Comment', value: column.comment === '' ? null : column.comment });
    }
  }

  return edits;
}

export function isTableDraftValid(draft: TableDraft): boolean {
  if (draft.name.trim() === '' || draft.code.trim() === '') return false;

  return draft.columns.every(
    (column) =>
      column.code.trim() !== '' && column.name.trim() !== '' && column.dataType.trim() !== '',
  );
}
