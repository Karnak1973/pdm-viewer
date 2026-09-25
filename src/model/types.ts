export interface Model {
  name: string;
  tables: Table[];
  references: Reference[];
  domains: Domain[];
}

export interface Table {
  id: string;
  code: string;
  name: string;
  comment?: string;
  position?: { x: number; y: number; w: number; h: number };
  columns: Column[];
  primaryKey?: string[];
  keys: Key[];
  indexes: Index[];
}

export interface Column {
  id: string;
  code: string;
  name: string;
  dataType: string;
  length?: number;
  precision?: number;
  mandatory: boolean;
  identity: boolean;
  defaultValue?: string;
  comment?: string;
}

export interface Reference {
  id: string;
  name: string;
  parentTable: string;
  childTable: string;
  joins: { parentColumn: string; childColumn: string }[];
  cardinality: string;
  onDelete?: string;
  onUpdate?: string;
}

export interface Key {
  id: string;
  name: string;
  columns: string[];
  isPrimary: boolean;
}

export interface Index {
  id: string;
  name: string;
  columns: string[];
  unique: boolean;
}

export interface Domain {
  id: string;
  name: string;
  dataType: string;
}
