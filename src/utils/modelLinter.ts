/**
 * Linter de modelos PowerDesigner.
 *
 * Revisa el esquema normalizado y devuelve una lista de incidencias con
 * severidad, más una puntuación de calidad 0..100 fácil de interpretar.
 *
 * La puntuación se normaliza por el tamaño del modelo (tablas + columnas +
 * relaciones) para que un modelo grande no quede penalizado en exceso.
 */

import type { Model, Table } from '../model/types';
import { splitIdentifier } from '../ml/text';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface LintIssue {
  id: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  tableId?: string;
  tableName?: string;
}

export interface LintReport {
  issues: LintIssue[];
  score: number;
  counts: Record<IssueSeverity, number>;
}

const PENALTY: Record<IssueSeverity, number> = {
  error: 6,
  warning: 2,
  info: 0.5,
};

const NUMERIC_TYPES = /^(number|numeric|decimal|integer|int|smallint|bigint|float|double|real|serial)/i;
const TEXT_TYPES = /^(varchar|varchar2|nvarchar|char|nchar|string|text)/i;

/** Comprueba si el identificador termina en "id" como palabra completa. */
function looksLikeIdentifier(columnCode: string): boolean {
  const tokens = splitIdentifier(columnCode).map((token) => token.toLowerCase());
  if (tokens.length === 0) return false;
  return tokens[tokens.length - 1] === 'id';
}

/** Extrae la longitud declarada en tipos como VARCHAR(200). */
function parsedLength(column: { dataType: string; length?: number }): number | undefined {
  if (typeof column.length === 'number' && column.length > 0) return column.length;
  const match = /\((\d+)/.exec(column.dataType);
  return match ? Number(match[1]) : undefined;
}

export function lintModel(model: Model): LintReport {
  const issues: LintIssue[] = [];
  let counter = 0;

  const push = (issue: Omit<LintIssue, 'id'>) => {
    counter += 1;
    issues.push({ id: `issue-${counter}`, ...issue });
  };

  const tableById = new Map(model.tables.map((table) => [table.id, table]));

  // Índice de columnas hijas que participan en alguna FK.
  const foreignKeyColumns = new Set<string>();
  for (const reference of model.references) {
    for (const join of reference.joins) {
      foreignKeyColumns.add(join.childColumn);
    }
  }

  // Índices que cubren cada columna de cada tabla.
  const indexedColumns = new Map<string, Set<string>>();
  for (const table of model.tables) {
    const covered = new Set<string>();
    for (const index of table.indexes) {
      // Un índice solo es útil para la primera columna de su lista.
      const leading = index.columns[0];
      if (leading) covered.add(leading);
    }
    for (const key of table.keys) {
      for (const columnId of key.columns) covered.add(columnId);
    }
    indexedColumns.set(table.id, covered);
  }

  const tableStyles = detectNamingConvention(model.tables);

  for (const table of model.tables) {
    // 1. Tabla sin columnas
    if (table.columns.length === 0) {
      push({
        severity: 'error',
        title: 'Tabla sin columnas',
        detail: `La tabla ${table.code} no define ninguna columna.`,
        tableId: table.id,
        tableName: table.name,
      });
    }

    // 2. Tabla sin clave primaria
    const primaryKey = table.primaryKey ?? table.keys.find((key) => key.isPrimary)?.columns ?? [];
    if (primaryKey.length === 0 && table.columns.length > 0) {
      push({
        severity: 'error',
        title: 'Tabla sin clave primaria',
        detail: `La tabla ${table.code} no tiene clave primaria definida.`,
        tableId: table.id,
        tableName: table.name,
      });
    }

    // 3. Columnas duplicadas dentro de la tabla
    const seen = new Map<string, number>();
    for (const column of table.columns) {
      const key = column.code.toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      if (count > 1) {
        push({
          severity: 'error',
          title: 'Columna duplicada',
          detail: `La columna ${key} aparece ${count} veces en ${table.code}.`,
          tableId: table.id,
          tableName: table.name,
        });
      }
    }

    // 4. Columnas de la PK anulables
    for (const columnId of primaryKey) {
      const column = table.columns.find((candidate) => candidate.id === columnId);
      if (column && !column.mandatory) {
        push({
          severity: 'error',
          title: 'Clave primaria anulable',
          detail: `La columna ${column.code} forma parte de la PK de ${table.code} pero admite NULL.`,
          tableId: table.id,
          tableName: table.name,
        });
      }
    }

    for (const column of table.columns) {
      const isPrimary = primaryKey.includes(column.id);
      const isForeign = foreignKeyColumns.has(column.id);

      // 5. Posible FK no declarada
      if (looksLikeIdentifier(column.code) && !isPrimary && !isForeign) {
        push({
          severity: 'warning',
          title: 'Posible FK sin declarar',
          detail: `${table.code}.${column.code} parece un identificador externo pero no participa en ninguna relación.`,
          tableId: table.id,
          tableName: table.name,
        });
      }

      // 6. FK sin índice que la cubra
      if (isForeign && !indexedColumns.get(table.id)?.has(column.id)) {
        push({
          severity: 'warning',
          title: 'Clave foránea sin índice',
          detail: `${table.code}.${column.code} es FK y no tiene índice, lo que penaliza los joins y los borrados.`,
          tableId: table.id,
          tableName: table.name,
        });
      }

      const length = parsedLength(column);

      // 7. Texto sin longitud
      if (TEXT_TYPES.test(column.dataType) && length === undefined) {
        push({
          severity: 'warning',
          title: 'Texto sin longitud',
          detail: `${table.code}.${column.code} usa ${column.dataType} sin longitud declarada.`,
          tableId: table.id,
          tableName: table.name,
        });
      }

      // 8. Texto por encima del máximo de VARCHAR2 en Oracle
      if (TEXT_TYPES.test(column.dataType) && length !== undefined && length > 4000) {
        push({
          severity: 'warning',
          title: 'VARCHAR2 fuera de rango',
          detail: `${table.code}.${column.code} declara ${length} caracteres; en Oracle conviene usar CLOB por encima de 4000.`,
          tableId: table.id,
          tableName: table.name,
        });
      }

      // 9. Identity sobre un tipo no numérico
      if (column.identity && !NUMERIC_TYPES.test(column.dataType)) {
        push({
          severity: 'error',
          title: 'Identity en columna no numérica',
          detail: `${table.code}.${column.code} es IDENTITY pero su tipo es ${column.dataType}.`,
          tableId: table.id,
          tableName: table.name,
        });
      }
    }

    // 10. Índices duplicados (mismo conjunto de columnas)
    const indexSignatures = new Map<string, string>();
    for (const index of table.indexes) {
      const signature = [...index.columns].sort().join(',');
      const previous = indexSignatures.get(signature);
      if (previous) {
        push({
          severity: 'warning',
          title: 'Índices duplicados',
          detail: `${table.code}: ${previous} e ${index.name} cubren las mismas columnas.`,
          tableId: table.id,
          tableName: table.name,
        });
      } else {
        indexSignatures.set(signature, index.name);
      }
    }

    // 11. Convención de nombres inconsistente
    if (tableStyles.dominant && tableStyles.deviants.has(table.code)) {
      push({
        severity: 'info',
        title: 'Convención de nombres inconsistente',
        detail: `La tabla ${table.code} no sigue el estilo dominante (${tableStyles.dominant}).`,
        tableId: table.id,
        tableName: table.name,
      });
    }
  }

  // Reglas sobre relaciones
  for (const reference of model.references) {
    const parent = tableById.get(reference.parentTable);
    const child = tableById.get(reference.childTable);
    const label = reference.name || reference.id;

    if (!parent || !child) {
      push({
        severity: 'error',
        title: 'Relación huérfana',
        detail: `La relación ${label} apunta a una tabla que no existe en el modelo.`,
      });
      continue;
    }

    for (const join of reference.joins) {
      const parentColumn = parent.columns.find((column) => column.id === join.parentColumn);
      const childColumn = child.columns.find((column) => column.id === join.childColumn);

      if (!parentColumn || !childColumn) {
        push({
          severity: 'error',
          title: 'Relación con columna inexistente',
          detail: `La relación ${label} referencia columnas que no existen.`,
          tableId: child.id,
          tableName: child.name,
        });
        continue;
      }

      const parentPrimary = (parent.primaryKey ?? []).includes(parentColumn.id);
      if (!parentPrimary) {
        push({
          severity: 'info',
          title: 'FK hacia columna no primaria',
          detail: `${label} apunta a ${parent.code}.${parentColumn.code}, que no forma parte de la clave primaria.`,
          tableId: child.id,
          tableName: child.name,
        });
      }
    }

    if (reference.parentTable === reference.childTable) {
      push({
        severity: 'info',
        title: 'Auto-referencia',
        detail: `La relación ${label} conecta ${parent.code} consigo misma; conviene documentarla.`,
        tableId: parent.id,
        tableName: parent.name,
      });
    }

    if (/[NM]\s*:\s*[NM]/i.test(reference.cardinality)) {
      push({
        severity: 'warning',
        title: 'Relación N:M sin resolver',
        detail: `La relación ${label} es N:M; normalmente requiere una tabla intermedia.`,
        tableId: child.id,
        tableName: child.name,
      });
    }

    if (reference.onDelete && /no action/i.test(reference.onDelete)) {
      push({
        severity: 'info',
        title: 'Borrado sin acción definida',
        detail: `La relación ${label} no define ON DELETE, así que el borrado fallará si hay hijos.`,
        tableId: child.id,
        tableName: child.name,
      });
    }
  }

  const counts: Record<IssueSeverity, number> = { error: 0, warning: 0, info: 0 };
  let penalty = 0;

  for (const issue of issues) {
    counts[issue.severity] += 1;
    penalty += PENALTY[issue.severity];
  }

  const columnCount = model.tables.reduce((total, table) => total + table.columns.length, 0);
  const units = Math.max(1, model.tables.length + columnCount + model.references.length);
  const score = Math.round(Math.max(0, Math.min(100, 100 * (1 - penalty / units))));

  return { issues, score, counts };
}

interface NamingAnalysis {
  dominant?: 'snake_case' | 'camelCase' | 'PascalCase';
  deviants: Set<string>;
}

/** Detecta el estilo de nombres dominante entre las tablas. */
function detectNamingConvention(tables: Table[]): NamingAnalysis {
  const styles = new Map<string, number>();

  const classify = (code: string): string => {
    if (code.includes('_')) return 'snake_case';
    if (/^[a-z]/.test(code) && /[A-Z]/.test(code)) return 'camelCase';
    if (/^[A-Z]/.test(code)) return 'PascalCase';
    return 'other';
  };

  for (const table of tables) {
    const style = classify(table.code);
    styles.set(style, (styles.get(style) ?? 0) + 1);
  }

  const ranked = [...styles.entries()].sort((a, b) => b[1] - a[1]);
  const [dominant, count] = ranked[0] ?? ['other', 0];

  // Con menos de tres tablas no hay base suficiente para hablar de convención.
  if (count < 3 || dominant === 'other') {
    return { deviants: new Set() };
  }

  const deviants = new Set(
    tables.map((table) => table.code).filter((code) => classify(code) !== dominant),
  );

  return { dominant: dominant as NamingAnalysis['dominant'], deviants };
}

/** Etiqueta legible de una severidad. */
export function severityLabel(severity: IssueSeverity): string {
  if (severity === 'error') return 'Error';
  if (severity === 'warning') return 'Aviso';
  return 'Sugerencia';
}
