/**
 * Registro de reglas del linter.
 *
 * Cada regla tiene un id estable, una categoría y una severidad por defecto.
 * El usuario puede cambiar la severidad o desactivar la regla por completo.
 */

import type { IssueSeverity } from './modelLinter';

export interface RuleDefinition {
  id: string;
  title: string;
  category: RuleCategory;
  defaultSeverity: IssueSeverity;
  description: string;
}

export type RuleCategory =
  | 'keys'
  | 'indexes'
  | 'naming'
  | 'types'
  | 'normalization'
  | 'relations';

export const RULE_CATEGORY_LABELS: Record<RuleCategory, string> = {
  keys: 'Claves y relaciones',
  indexes: 'Índices',
  naming: 'Nombres y convenciones',
  types: 'Tipos y dominios',
  normalization: 'Normalización',
  relations: 'Relaciones',
};

export const RULES: RuleDefinition[] = [
  {
    id: 'table-empty',
    title: 'Tabla sin columnas',
    category: 'keys',
    defaultSeverity: 'error',
    description: 'La tabla no define ninguna columna.',
  },
  {
    id: 'table-no-pk',
    title: 'Tabla sin clave primaria',
    category: 'keys',
    defaultSeverity: 'error',
    description: 'La tabla no tiene clave primaria definida.',
  },
  {
    id: 'column-duplicate',
    title: 'Columna duplicada',
    category: 'keys',
    defaultSeverity: 'error',
    description: 'La misma columna aparece más de una vez en la tabla.',
  },
  {
    id: 'pk-nullable',
    title: 'Clave primaria anulable',
    category: 'keys',
    defaultSeverity: 'error',
    description: 'Una columna de la PK admite NULL.',
  },
  {
    id: 'fk-undeclared',
    title: 'Posible FK sin declarar',
    category: 'keys',
    defaultSeverity: 'warning',
    description: 'La columna parece un identificador externo pero no participa en ninguna relación.',
  },
  {
    id: 'fk-no-index',
    title: 'Clave foránea sin índice',
    category: 'indexes',
    defaultSeverity: 'warning',
    description: 'Columna FK sin índice que la cubra; penaliza joins y borrados.',
  },
  {
    id: 'text-no-length',
    title: 'Texto sin longitud',
    category: 'types',
    defaultSeverity: 'warning',
    description: 'Tipo VARCHAR/CHAR sin longitud declarada.',
  },
  {
    id: 'varchar-out-of-range',
    title: 'VARCHAR fuera de rango',
    category: 'types',
    defaultSeverity: 'warning',
    description: 'VARCHAR2 por encima de 4000 caracteres; conviene CLOB.',
  },
  {
    id: 'identity-non-numeric',
    title: 'Identity en columna no numérica',
    category: 'types',
    defaultSeverity: 'error',
    description: 'Columna IDENTITY con tipo no numérico.',
  },
  {
    id: 'index-duplicate',
    title: 'Índices duplicados',
    category: 'indexes',
    defaultSeverity: 'warning',
    description: 'Dos índices cubren el mismo conjunto de columnas.',
  },
  {
    id: 'naming-inconsistent',
    title: 'Convención de nombres inconsistente',
    category: 'naming',
    defaultSeverity: 'info',
    description: 'El nombre no sigue el estilo dominante del modelo.',
  },
  {
    id: 'reference-orphan',
    title: 'Relación huérfana',
    category: 'relations',
    defaultSeverity: 'error',
    description: 'La relación apunta a una tabla que no existe.',
  },
  {
    id: 'reference-missing-column',
    title: 'Relación con columna inexistente',
    category: 'relations',
    defaultSeverity: 'error',
    description: 'La relación referencia columnas que no existen.',
  },
  {
    id: 'fk-non-pk',
    title: 'FK hacia columna no primaria',
    category: 'relations',
    defaultSeverity: 'info',
    description: 'La FK apunta a una columna que no forma parte de la PK.',
  },
  {
    id: 'self-reference',
    title: 'Auto-referencia',
    category: 'relations',
    defaultSeverity: 'info',
    description: 'La relación conecta una tabla consigo misma.',
  },
  {
    id: 'many-to-many',
    title: 'Relación N:M sin resolver',
    category: 'relations',
    defaultSeverity: 'warning',
    description: 'Relación N:M que normalmente requiere tabla intermedia.',
  },
  {
    id: 'delete-no-action',
    title: 'Borrado sin acción definida',
    category: 'relations',
    defaultSeverity: 'info',
    description: 'La relación no define ON DELETE; el borrado fallará si hay hijos.',
  },
];

export const RULES_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

/** Severidad efectiva de una regla dada la configuración del usuario. */
export type RuleSeverity = IssueSeverity | 'off';

export type RuleConfig = Record<string, RuleSeverity>;

/** Configuración por defecto: todas las reglas con su severidad original. */
export function defaultRuleConfig(): RuleConfig {
  const config: RuleConfig = {};
  for (const rule of RULES) config[rule.id] = rule.defaultSeverity;
  return config;
}
