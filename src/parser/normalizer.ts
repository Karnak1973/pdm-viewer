import type { Column, Domain, Key, Index, Model, Reference, Table } from '../model/types';

function stripNamespace(value: string): string {
  return value.replace(/^.*:/, '').toLowerCase();
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function scalarValue(value: unknown): string | number | boolean | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return scalarValue(value[0]);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record['#text'] !== undefined) return String(record['#text']);
    if (record.value !== undefined) return scalarValue(record.value);
    if (record.text !== undefined) return scalarValue(record.text);
    const entries = Object.entries(record);
    if (entries.length === 1) return scalarValue(entries[0][1]);
  }
  return undefined;
}

function readValue(source: Record<string, unknown> | undefined, names: string[]): string | number | boolean | undefined {
  if (!source) return undefined;

  const entries = Object.entries(source);
  const matches = new Map<string, unknown>();

  for (const [key, value] of entries) {
    matches.set(stripNamespace(key), value);
  }

  for (const name of names) {
    const normalized = stripNamespace(name);
    if (matches.has(normalized)) return scalarValue(matches.get(normalized));

    const direct = source[name];
    if (direct !== undefined) return scalarValue(direct);
  }

  return undefined;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y';
  }
  return Boolean(value);
}

function toKeyId(prefix: string, index: number): string {
  return `${prefix}-${index}`;
}

const CONSTRAINT_LABELS = ['None', 'Restrict', 'Cascade', 'Set Null', 'Set Default'];

function readPdId(node: Record<string, unknown> | undefined): string | undefined {
  const value = node ? readValue(node, ['Id', 'id']) : undefined;
  return value == null ? undefined : String(value);
}

function readConstraint(source: Record<string, unknown> | undefined, names: string[]): string | undefined {
  const raw = readValue(source, names);
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) {
    const index = Number(text);
    if (index >= 0 && index < CONSTRAINT_LABELS.length) return CONSTRAINT_LABELS[index];
  }
  return text;
}

function parseRect(value: string): { x: number; y: number; w: number; h: number } | undefined {
  const numbers = value.match(/-?\d+/g);
  if (!numbers || numbers.length < 4) return undefined;
  const [x1, y1, x2, y2] = numbers.map(Number);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    return undefined;
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function findByName(root: unknown, names: string[]): unknown {
  if (root == null || typeof root !== 'object') return undefined;

  const record = root as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (names.some((name) => stripNamespace(name) === stripNamespace(key))) {
      return value;
    }
  }

  for (const value of Object.values(record)) {
    const nested = findByName(value, names);
    if (nested !== undefined) return nested;
  }

  return undefined;
}

function collectNodes(root: unknown, names: string[]): unknown[] {
  if (root == null || typeof root !== 'object') return [];

  const record = root as Record<string, unknown>;
  const results: unknown[] = [];

  for (const [key, value] of Object.entries(record)) {
    if (names.some((name) => stripNamespace(name) === stripNamespace(key))) {
      results.push(...asArray(value));
    }
    results.push(...collectNodes(value, names));
  }

  return results;
}

function nodeText(node: unknown, candidates: string[]): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);

  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    const literal = readValue(record, candidates);
    if (literal != null) return String(literal);

    for (const value of Object.values(record)) {
      const nested = nodeText(value, candidates);
      if (nested) return nested;
    }
  }

  return '';
}

function normalizeColumn(columnNode: Record<string, unknown>, index: number): Column {
  const code = String(readValue(columnNode, ['Code', 'code']) ?? `column_${index}`);
  const name = String(readValue(columnNode, ['Name', 'name']) ?? code);
  const type = String(readValue(columnNode, ['DataType', 'dataType', 'Type', 'type']) ?? 'unknown');
  const length = Number(readValue(columnNode, ['Length', 'length'])) || undefined;
  const precision = Number(readValue(columnNode, ['Precision', 'precision'])) || undefined;
  const mandatory = toBoolean(
    readValue(columnNode, ['Column.Mandatory', 'Mandatory', 'mandatory', 'NotNull', 'notNull']),
  );
  const identity = toBoolean(
    readValue(columnNode, ['Column.Identity', 'Identity', 'identity', 'IsIdentity', 'isIdentity']),
  );
  const defaultValue = readValue(columnNode, ['DefaultValue', 'defaultValue', 'Default', 'default']);

  return {
    id: toKeyId('column', index),
    pdId: readPdId(columnNode),
    code,
    name,
    dataType: type,
    length,
    precision,
    mandatory,
    identity,
    defaultValue: defaultValue == null ? undefined : String(defaultValue),
    comment: readValue(columnNode, ['Comment', 'comment']) == null ? undefined : String(readValue(columnNode, ['Comment', 'comment'])),
  };
}

function resolveColumnIds(columns: Column[], values: string[], byPdId?: Map<string, string>): string[] {
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const column of columns) {
    byCode.set(String(column.code).trim().toLowerCase(), column.id);
    byName.set(String(column.name).trim().toLowerCase(), column.id);
  }

  return values
    .map((value) => {
      const entry = String(value).trim();
      if (!entry) return undefined;
      const normalized = entry.toLowerCase();
      return (
        byPdId?.get(normalized) ??
        byCode.get(normalized) ??
        byName.get(normalized) ??
        entry
      );
    })
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function normalizeKeyNode(
  keyNode: Record<string, unknown>,
  index: number,
  tableColumns: Column[],
  columnByPdId: Map<string, string>,
): Key {
  const name = String(readValue(keyNode, ['Name', 'name']) ?? `key_${index}`);
  const columns = resolveColumnIds(
    tableColumns,
    collectNodes(keyNode, ['Column'])
      .map((column) => nodeText(column, ['Code', 'code', 'Name', 'name', 'Id', 'id']))
      .filter(Boolean),
    columnByPdId,
  );

  return {
    id: toKeyId('key', index),
    pdId: readPdId(keyNode),
    name,
    columns,
    isPrimary: name.toLowerCase().includes('primary') || toBoolean(readValue(keyNode, ['Primary', 'primary'])),
  };
}

function normalizeIndexNode(
  indexNode: Record<string, unknown>,
  index: number,
  tableColumns: Column[],
  columnByPdId: Map<string, string>,
): Index {
  const name = String(readValue(indexNode, ['Name', 'name']) ?? `index_${index}`);

  const values: string[] = [];
  for (const entry of collectNodes(indexNode, ['IndexColumn'])) {
    const record = (entry as Record<string, unknown>) ?? {};
    const expression = readValue(record, ['IndexColumn.Expression', 'Expression', 'expression']);
    if (expression != null) {
      values.push(String(expression));
      continue;
    }
    const text = nodeText(record, ['Code', 'code', 'Name', 'name', 'Expression', 'expression']);
    if (text) values.push(text);
  }

  if (values.length === 0) {
    for (const entry of collectNodes(indexNode, ['Column'])) {
      const text = nodeText(entry, ['Code', 'code', 'Name', 'name', 'Id', 'id']);
      if (text) values.push(text);
    }
  }

  const columns = resolveColumnIds(tableColumns, values, columnByPdId);

  return {
    id: toKeyId('index', index),
    pdId: readPdId(indexNode),
    name,
    columns,
    unique: toBoolean(readValue(indexNode, ['Unique', 'unique'])),
  };
}

interface IdCounter {
  column: number;
  key: number;
  index: number;
}

function normalizeTable(tableNode: Record<string, unknown>, index: number, ids: IdCounter): Table {
  const code = String(readValue(tableNode, ['Code', 'code']) ?? `table_${index}`);
  const name = String(readValue(tableNode, ['Name', 'name']) ?? code);
  const columnsNode = findByName(tableNode, ['Columns']);
  const columns = collectNodes(columnsNode ?? tableNode, ['Column']).map((entry) =>
    normalizeColumn((entry as Record<string, unknown>) ?? {}, ids.column++),
  );

  const columnByPdId = new Map<string, string>();
  for (const column of columns) {
    if (column.pdId) columnByPdId.set(column.pdId.trim().toLowerCase(), column.id);
  }

  const keysNode = findByName(tableNode, ['Keys']);
  const keys = collectNodes(keysNode ?? tableNode, ['Key']).map((entry) =>
    normalizeKeyNode((entry as Record<string, unknown>) ?? {}, ids.key++, columns, columnByPdId),
  );

  const primaryKeyRaw = findByName(tableNode, ['PrimaryKey']);
  let primaryKey: string[] = [];

  if (primaryKeyRaw) {
    const refs = collectNodes(primaryKeyRaw, ['Key'])
      .map((entry) => scalarValue(entry))
      .filter((value): value is string | number => value != null)
      .map((value) => String(value).trim().toLowerCase())
      .filter(Boolean);

    const primary =
      refs.length > 0
        ? keys.find((key) => key.pdId != null && refs.includes(key.pdId.trim().toLowerCase()))
        : undefined;

    if (primary) {
      primary.isPrimary = true;
      primaryKey = [...primary.columns];
    } else {
      primaryKey = resolveColumnIds(
        columns,
        collectNodes(primaryKeyRaw, ['Column'])
          .map((entry) => nodeText(entry, ['Code', 'code', 'Name', 'name', 'Id', 'id']))
          .filter(Boolean),
        columnByPdId,
      );
    }
  }

  const indexesNode = findByName(tableNode, ['Indexes']);
  const indexes = collectNodes(indexesNode ?? tableNode, ['Index']).map((entry) =>
    normalizeIndexNode((entry as Record<string, unknown>) ?? {}, ids.index++, columns, columnByPdId),
  );

  return {
    id: toKeyId('table', index),
    pdId: readPdId(tableNode),
    code,
    name,
    comment: readValue(tableNode, ['Comment', 'comment']) == null ? undefined : String(readValue(tableNode, ['Comment', 'comment'])),
    position: undefined,
    columns,
    primaryKey: primaryKey.length > 0 ? primaryKey : undefined,
    keys,
    indexes,
  };
}

function normalizeReference(referenceNode: Record<string, unknown>, index: number): Reference {
  const name = String(readValue(referenceNode, ['Name', 'name']) ?? `reference_${index}`);
  const joinsNode = findByName(referenceNode, ['Joins']);
  const joins = collectNodes(joinsNode ?? referenceNode, ['Join', 'ReferenceJoin']).map((joinEntry) => {
    const join = (joinEntry as Record<string, unknown>) ?? {};

    const legacyParent = readValue(join, ['ParentColumn', 'parentColumn']);
    const legacyChild = readValue(join, ['ChildColumn', 'childColumn']);
    if (legacyParent != null || legacyChild != null) {
      return {
        parentColumn: String(legacyParent ?? ''),
        childColumn: String(legacyChild ?? ''),
      };
    }

    const object1 = findByName(join, ['Object1']);
    const object2 = findByName(join, ['Object2']);
    const parent = object1 == null ? undefined : scalarValue(object1);
    const child = object2 == null ? undefined : scalarValue(object2);

    return {
      parentColumn: parent == null ? '' : String(parent),
      childColumn: child == null ? '' : String(child),
    };
  });

  return {
    id: toKeyId('reference', index),
    pdId: readPdId(referenceNode),
    name,
    parentTable: String(readValue(referenceNode, ['ParentTable', 'parentTable']) ?? ''),
    childTable: String(readValue(referenceNode, ['ChildTable', 'childTable']) ?? ''),
    joins,
    cardinality: String(readValue(referenceNode, ['Cardinality', 'cardinality']) ?? 'N:1'),
    onDelete: readConstraint(referenceNode, ['OnDelete', 'onDelete', 'DeleteConstraint', 'deleteConstraint']),
    onUpdate: readConstraint(referenceNode, ['OnUpdate', 'onUpdate', 'UpdateConstraint', 'updateConstraint']),
  };
}

function normalizeDomains(domainsNode: Record<string, unknown> | undefined): Domain[] {
  if (!domainsNode) return [];

  return collectNodes(domainsNode, ['Domain']).map((entry, index) => {
    const domain = (entry as Record<string, unknown>) ?? {};
    return {
      id: toKeyId('domain', index),
      name: String(readValue(domain, ['Name', 'name']) ?? `domain_${index}`),
      dataType: String(readValue(domain, ['DataType', 'dataType']) ?? 'unknown'),
    };
  });
}

function attachTablePositions(model: Record<string, unknown>, tables: Table[]): Table[] {
  const symbolsNode = findByName(model, ['TableSymbols']);
  const symbols = collectNodes(symbolsNode ?? model, ['TableSymbol']);

  interface SymbolEntry {
    key: string;
    position: { x: number; y: number; w: number; h: number };
    fromRect: boolean;
  }

  const entries: SymbolEntry[] = [];

  for (const symbol of symbols) {
    const entry = (symbol as Record<string, unknown>) ?? {};

    const objectNode = findByName(entry, ['Object']);
    let tableRef: unknown = objectNode == null ? undefined : scalarValue(objectNode);
    if (tableRef == null) {
      tableRef = readValue(entry, ['Table', 'table', 'Code', 'code', 'Name', 'name']);
    }
    if (tableRef == null || String(tableRef).trim() === '') continue;

    const rectValue = readValue(entry, ['Rect', 'rect']);
    let position = rectValue == null ? undefined : parseRect(String(rectValue));
    const fromRect = position != null;

    if (!position) {
      position = {
        x: Number(readValue(entry, ['X', 'x'])) || 0,
        y: Number(readValue(entry, ['Y', 'y'])) || 0,
        w: Number(readValue(entry, ['Width', 'width', 'W', 'w'])) || 220,
        h: Number(readValue(entry, ['Height', 'height', 'H', 'h'])) || 180,
      };
    }

    entries.push({ key: String(tableRef).trim().toLowerCase(), position, fromRect });
  }

  const rectWidths = entries.filter((entry) => entry.fromRect).map((entry) => entry.position.w).filter((w) => w > 0);
  const scale = rectWidths.length > 0 ? 240 / (median(rectWidths) || 240) : 1;

  const symbolMap = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const entry of entries) {
    const position = entry.fromRect
      ? {
          x: entry.position.x * scale,
          y: entry.position.y * scale,
          w: entry.position.w * scale,
          h: entry.position.h * scale,
        }
      : entry.position;
    symbolMap.set(entry.key, position);
  }

  return tables.map((table) => {
    const position =
      (table.pdId ? symbolMap.get(table.pdId.trim().toLowerCase()) : undefined) ??
      symbolMap.get(String(table.code).trim().toLowerCase()) ??
      symbolMap.get(String(table.name).trim().toLowerCase());

    return {
      ...table,
      position: position ?? table.position,
    };
  });
}

function normalizeReferenceKey(value: string): string {
  return value.trim().toLowerCase();
}

function resolveReferenceIds(references: Reference[], tables: Table[]): Reference[] {
  const tableIds = new Map<string, string>();
  const columnIdsByTable = new Map<string, Map<string, string>>();

  for (const table of tables) {
    tableIds.set(normalizeReferenceKey(table.id), table.id);
    tableIds.set(normalizeReferenceKey(table.code), table.id);
    tableIds.set(normalizeReferenceKey(table.name), table.id);
    if (table.pdId) tableIds.set(normalizeReferenceKey(table.pdId), table.id);

    const columnMap = new Map<string, string>();
    for (const column of table.columns) {
      columnMap.set(normalizeReferenceKey(column.id), column.id);
      columnMap.set(normalizeReferenceKey(column.code), column.id);
      columnMap.set(normalizeReferenceKey(column.name), column.id);
      if (column.pdId) columnMap.set(normalizeReferenceKey(column.pdId), column.id);
    }
    columnIdsByTable.set(table.id, columnMap);
  }

  return references.map((reference) => {
    const parentTable = tableIds.get(normalizeReferenceKey(reference.parentTable)) ?? reference.parentTable;
    const childTable = tableIds.get(normalizeReferenceKey(reference.childTable)) ?? reference.childTable;

    const parentColumns = columnIdsByTable.get(parentTable) ?? new Map<string, string>();
    const childColumns = columnIdsByTable.get(childTable) ?? new Map<string, string>();

    return {
      ...reference,
      parentTable,
      childTable,
      joins: reference.joins.map((join) => ({
        parentColumn: parentColumns.get(normalizeReferenceKey(join.parentColumn)) ?? join.parentColumn,
        childColumn: childColumns.get(normalizeReferenceKey(join.childColumn)) ?? join.childColumn,
      })),
    };
  });
}

function readRootModel(rootNode: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!rootNode) return undefined;

  const modelNode = findByName(rootNode, ['Model']);
  if (modelNode && typeof modelNode === 'object') return modelNode as Record<string, unknown>;

  for (const value of Object.values(rootNode)) {
    if (value && typeof value === 'object' && findByName(value, ['Tables'])) {
      return rootNode;
    }
  }

  return rootNode;
}

export function normalizeModel(xmlRoot: Record<string, unknown>, modelName = 'PowerDesigner model'): Model {
  const model = readRootModel(xmlRoot) ?? xmlRoot;
  const ids: IdCounter = { column: 0, key: 0, index: 0 };

  const tablesNode = findByName(model, ['Tables']);
  const tableEntries = collectNodes(tablesNode ?? model, ['Table']);
  const tables = tableEntries.map((entry, index) => normalizeTable((entry as Record<string, unknown>) ?? {}, index, ids));

  const referencesNode = findByName(model, ['References']);
  const referenceEntries = collectNodes(referencesNode ?? model, ['Reference']);
  const references = referenceEntries.map((entry, index) => normalizeReference((entry as Record<string, unknown>) ?? {}, index));

  const domainNode = findByName(model, ['Domains']);
  const normalizedTables = attachTablePositions(model, tables);
  const normalizedReferences = resolveReferenceIds(references, normalizedTables);

  return {
    name: String(readValue(model, ['Name', 'name']) ?? modelName),
    tables: normalizedTables,
    references: normalizedReferences,
    domains: normalizeDomains(domainNode as Record<string, unknown> | undefined),
  };
}
