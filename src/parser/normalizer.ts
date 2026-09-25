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
  const mandatory = toBoolean(readValue(columnNode, ['Mandatory', 'mandatory', 'NotNull', 'notNull']));
  const identity = toBoolean(readValue(columnNode, ['Identity', 'identity', 'IsIdentity', 'isIdentity']));
  const defaultValue = readValue(columnNode, ['DefaultValue', 'defaultValue', 'Default', 'default']);

  return {
    id: toKeyId('column', index),
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

function resolveColumnIds(columns: Column[], values: string[]): string[] {
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
      return byCode.get(normalized) ?? byName.get(normalized) ?? entry;
    })
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function normalizeKeyNode(keyNode: Record<string, unknown>, index: number, tableColumns: Column[]): Key {
  const name = String(readValue(keyNode, ['Name', 'name']) ?? `key_${index}`);
  const columns = resolveColumnIds(
    tableColumns,
    collectNodes(keyNode, ['Column'])
      .map((column) => nodeText(column, ['Code', 'code', 'Name', 'name', 'Id', 'id']))
      .filter(Boolean),
  );

  return {
    id: toKeyId('key', index),
    name,
    columns,
    isPrimary: name.toLowerCase().includes('primary') || toBoolean(readValue(keyNode, ['Primary', 'primary'])),
  };
}

function normalizeIndexNode(indexNode: Record<string, unknown>, index: number, tableColumns: Column[]): Index {
  const name = String(readValue(indexNode, ['Name', 'name']) ?? `index_${index}`);
  const columns = resolveColumnIds(
    tableColumns,
    collectNodes(indexNode, ['Column'])
      .map((column) => nodeText(column, ['Code', 'code', 'Name', 'name', 'Id', 'id']))
      .filter(Boolean),
  );

  return {
    id: toKeyId('index', index),
    name,
    columns,
    unique: toBoolean(readValue(indexNode, ['Unique', 'unique'])),
  };
}

function normalizeTable(tableNode: Record<string, unknown>, index: number): Table {
  const code = String(readValue(tableNode, ['Code', 'code']) ?? `table_${index}`);
  const name = String(readValue(tableNode, ['Name', 'name']) ?? code);
  const columnsNode = findByName(tableNode, ['Columns']);
  const columns = collectNodes(columnsNode ?? tableNode, ['Column']).map((entry, columnIndex) => normalizeColumn((entry as Record<string, unknown>) ?? {}, columnIndex));

  const primaryKeyRaw = findByName(tableNode, ['PrimaryKey']);
  const primaryKey = resolveColumnIds(
    columns,
    collectNodes(primaryKeyRaw ?? tableNode, ['Column'])
      .map((entry) => nodeText(entry, ['Code', 'code', 'Name', 'name', 'Id', 'id']))
      .filter(Boolean),
  );

  const keysNode = findByName(tableNode, ['Keys']);
  const keys = collectNodes(keysNode ?? tableNode, ['Key']).map((entry, keyIndex) => normalizeKeyNode((entry as Record<string, unknown>) ?? {}, keyIndex, columns));

  const indexesNode = findByName(tableNode, ['Indexes']);
  const indexes = collectNodes(indexesNode ?? tableNode, ['Index']).map((entry, indexIndex) => normalizeIndexNode((entry as Record<string, unknown>) ?? {}, indexIndex, columns));

  return {
    id: toKeyId('table', index),
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
  const joins = collectNodes(joinsNode ?? referenceNode, ['Join']).map((joinEntry) => {
    const join = (joinEntry as Record<string, unknown>) ?? {};
    return {
      parentColumn: String(readValue(join, ['ParentColumn', 'parentColumn']) ?? ''),
      childColumn: String(readValue(join, ['ChildColumn', 'childColumn']) ?? ''),
    };
  });

  return {
    id: toKeyId('reference', index),
    name,
    parentTable: String(readValue(referenceNode, ['ParentTable', 'parentTable']) ?? ''),
    childTable: String(readValue(referenceNode, ['ChildTable', 'childTable']) ?? ''),
    joins,
    cardinality: String(readValue(referenceNode, ['Cardinality', 'cardinality']) ?? 'N:1'),
    onDelete: readValue(referenceNode, ['OnDelete', 'onDelete']) == null ? undefined : String(readValue(referenceNode, ['OnDelete', 'onDelete'])),
    onUpdate: readValue(referenceNode, ['OnUpdate', 'onUpdate']) == null ? undefined : String(readValue(referenceNode, ['OnUpdate', 'onUpdate'])),
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

  const symbolMap = new Map<string, { x: number; y: number; w: number; h: number }>();

  for (const symbol of symbols) {
    const entry = (symbol as Record<string, unknown>) ?? {};
    const tableRef = nodeText(entry, ['Table', 'table', 'Code', 'code', 'Name', 'name']);
    const x = Number(readValue(entry, ['X', 'x'])) || 0;
    const y = Number(readValue(entry, ['Y', 'y'])) || 0;
    const w = Number(readValue(entry, ['Width', 'width', 'W', 'w'])) || 220;
    const h = Number(readValue(entry, ['Height', 'height', 'H', 'h'])) || 180;

    if (tableRef) {
      symbolMap.set(tableRef.trim().toLowerCase(), { x, y, w, h });
    }
  }

  return tables.map((table) => {
    const position = symbolMap.get(String(table.code).trim().toLowerCase())
      ?? symbolMap.get(String(table.name).trim().toLowerCase());

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

    const columnMap = new Map<string, string>();
    for (const column of table.columns) {
      columnMap.set(normalizeReferenceKey(column.id), column.id);
      columnMap.set(normalizeReferenceKey(column.code), column.id);
      columnMap.set(normalizeReferenceKey(column.name), column.id);
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

  const tablesNode = findByName(model, ['Tables']);
  const tableEntries = collectNodes(tablesNode ?? model, ['Table']);
  const tables = tableEntries.map((entry, index) => normalizeTable((entry as Record<string, unknown>) ?? {}, index));

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
