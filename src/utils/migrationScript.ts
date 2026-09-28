/**
 * Motor de scripts de migración Oracle.
 *
 * Compara el modelo cargado (base) con el modelo objetivo (un segundo .pdm)
 * y genera el SQL necesario para llevar la base de datos de uno al otro.
 *
 * El orden importa: Oracle no deja tocar una columna que forma parte de una
 * clave primaria ni de una clave foránea, así que hay que soltar primero las
 * FKs hijas, luego los índices, luego la PK, y solo después alterar columnas.
 *
 * Fases del script:
 *   1. Prevalidación (comentada, para ejecutar a mano)
 *   2. DROP de las claves foráneas afectadas
 *   3. DROP de los índices que cubren columnas tocadas
 *   4. DROP de las claves primarias modificadas
 *   5. Tablas: renombrar, crear y eliminar
 *   6. Columnas: renombrar, modificar, añadir y eliminar
 *   7. ADD de las claves primarias nuevas
 *   8. CREATE de los índices nuevos
 *   9. ADD de las claves foráneas
 *  10. Comentarios
 *
 * El rollback se genera con el mismo análisis y los modelos intercambiados,
 * de modo que es el espejo exacto del script directo.
 */

import type { Column, Model, Reference, Table } from '../model/types';
import { pairByCode } from './modelDiff';
import {
  escapeIdentifier,
  formatDataType,
  formatDefaultValue,
  generateIndexSql,
  generateReferenceSql,
  generateTableSql,
  pkConstraintName,
} from './sqlGenerator';

export interface ImpactedChild {
  tableId: string;
  name: string;
  reference: string;
}

export interface TableImpact {
  tableId: string;
  tableName: string;
  kind: 'modified' | 'added' | 'removed' | 'affected';
  changes: string[];
  childTables: ImpactedChild[];
  outgoingFks: string[];
  indexes: string[];
}

export interface MigrationScript {
  forward: string;
  rollback: string;
  impact: TableImpact[];
  statementCount: number;
  rollbackStatementCount: number;
}

interface ColumnChange {
  before: Column;
  after: Column;
  renamed: boolean;
  typeChanged: boolean;
  nullableChanged: boolean;
  defaultChanged: boolean;
}

interface IndexChange {
  name: string;
  reason: string;
}

interface TablePlan {
  base?: Table;
  target?: Table;
  tableId: string;
  kind: TableImpact['kind'];
  changes: string[];
  columnChanges: ColumnChange[];
  addedColumns: Column[];
  removedColumns: Column[];
  pkChanged: boolean;
  indexesToDrop: IndexChange[];
  indexesToCreate: IndexChange[];
  keysToDrop: IndexChange[];
  keysToCreate: IndexChange[];
  commentChanged: boolean;
}

interface ReferenceImpact {
  base?: Reference;
  target?: Reference;
  dropped: boolean;
  recreated: boolean;
  note: string;
}

interface PlanSections {
  preChecks: string[];
  dropFks: string[];
  dropIndexes: string[];
  dropPks: string[];
  tableOps: string[];
  columnOps: string[];
  addPks: string[];
  createIndexes: string[];
  addFks: string[];
  commentOps: string[];
}

interface Analysis {
  sections: PlanSections;
  impact: TableImpact[];
  lossy: boolean;
}

/** Busca una columna por id, code o name, igual que hace el generador de DDL. */
function findColumn(table: Table | undefined, columnId: string | undefined): Column | undefined {
  if (!table || !columnId) return undefined;
  return table.columns.find(
    (column) => column.id === columnId || column.code === columnId || column.name === columnId,
  );
}

/** Columnas que forman la clave primaria, en el orden declarado. */
function primaryKeyCodes(table: Table): string[] {
  const ids = table.primaryKey ?? table.keys.find((key) => key.isPrimary)?.columns ?? [];
  return ids
    .map((columnId) => findColumn(table, columnId)?.code)
    .filter((code): code is string => Boolean(code));
}

function quoteComment(value: string | undefined): string {
  if (!value) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

function sameSequence(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Compara una relación por su contenido, no por ids posicionales. */
function referenceSignature(reference: Reference, tables: Map<string, Table>): string {
  const parent = tables.get(reference.parentTable);
  const child = tables.get(reference.childTable);
  const parentColumns = reference.joins
    .map((join) => findColumn(parent, join.parentColumn)?.code ?? join.parentColumn)
    .join(',');
  const childColumns = reference.joins
    .map((join) => findColumn(child, join.childColumn)?.code ?? join.childColumn)
    .join(',');

  return [
    reference.name,
    parent?.code ?? reference.parentTable,
    child?.code ?? reference.childTable,
    parentColumns,
    childColumns,
    reference.cardinality,
    reference.onDelete ?? '',
    reference.onUpdate ?? '',
  ].join('|');
}

function emptySections(): PlanSections {
  return {
    preChecks: [],
    dropFks: [],
    dropIndexes: [],
    dropPks: [],
    tableOps: [],
    columnOps: [],
    addPks: [],
    createIndexes: [],
    addFks: [],
    commentOps: [],
  };
}

/**
 * Analiza el paso de un modelo a otro y devuelve las fases del script
 * más el informe de impacto. Es la única fuente de verdad: el script
 * directo y el rollback salen de aquí con los modelos en un orden u otro.
 */
function analyze(from: Model, to: Model): Analysis {
  const fromTables = new Map(from.tables.map((table) => [table.id, table]));
  const toTables = new Map(to.tables.map((table) => [table.id, table]));

  const { baseOnly: removedTables, targetOnly: addedTables, paired: pairedTables } = pairByCode(
    from.tables,
    to.tables,
  );

  const plans = new Map<string, TablePlan>();
  const planOf = (fromTable: Table | undefined, toTable: Table | undefined): TablePlan => {
    const key = fromTable?.id ?? toTable?.id ?? '';
    const existing = plans.get(key);
    if (existing) return existing;
    const plan: TablePlan = {
      base: fromTable,
      target: toTable,
      tableId: key,
      kind: 'modified',
      changes: [],
      columnChanges: [],
      addedColumns: [],
      removedColumns: [],
      pkChanged: false,
      indexesToDrop: [],
      indexesToCreate: [],
      keysToDrop: [],
      keysToCreate: [],
      commentChanged: false,
    };
    plans.set(key, plan);
    return plan;
  };

  for (const [fromTable, toTable] of pairedTables) {
    const plan = planOf(fromTable, toTable);

    if (fromTable.name !== toTable.name) {
      plan.changes.push(`Tabla renombrada: ${fromTable.name} → ${toTable.name}`);
    }
    if ((fromTable.comment ?? '') !== (toTable.comment ?? '')) {
      plan.commentChanged = true;
      plan.changes.push(
        toTable.comment
          ? `Comentario de la tabla: ${toTable.comment}`
          : 'Comentario de la tabla eliminado',
      );
    }

    const { baseOnly, targetOnly, paired: pairedColumns } = pairByCode(
      fromTable.columns,
      toTable.columns,
    );

    // Columnas cuya definición física o lógica cambia: obligan a rehacer PK y FKs.
    const touched = new Set<string>();
    const renamed = new Set<string>();

    for (const [before, after] of pairedColumns) {
      const column: ColumnChange = {
        before,
        after,
        renamed: before.name !== after.name,
        typeChanged:
          before.dataType !== after.dataType ||
          (before.length ?? 0) !== (after.length ?? 0) ||
          (before.precision ?? 0) !== (after.precision ?? 0),
        nullableChanged: before.mandatory !== after.mandatory,
        defaultChanged: (before.defaultValue ?? '') !== (after.defaultValue ?? ''),
      };

      if (
        column.renamed ||
        column.typeChanged ||
        column.nullableChanged ||
        column.defaultChanged
      ) {
        plan.columnChanges.push(column);
      }

      if (column.renamed) {
        touched.add(after.code);
        renamed.add(after.code);
        plan.changes.push(`Columna renombrada: ${before.name} → ${after.name}`);
      }
      if (column.typeChanged) {
        touched.add(after.code);
        plan.changes.push(
          `Tipo de ${after.name}: ${formatDataType(before)} → ${formatDataType(after)}`,
        );
      }
      if (column.nullableChanged) {
        touched.add(after.code);
        plan.changes.push(
          after.mandatory ? `${after.name} pasa a NOT NULL` : `${after.name} admite NULL`,
        );
      }
      if (column.defaultChanged) {
        touched.add(after.code);
        plan.changes.push(
          after.defaultValue
            ? `Default de ${after.name}: ${after.defaultValue}`
            : `Default de ${after.name} eliminado`,
        );
      }
      if (before.identity !== after.identity) {
        plan.changes.push(
          `IDENTITY de ${after.name}: ${before.identity ? 'sí' : 'no'} → ${
            after.identity ? 'sí' : 'no'
          } (puede exigir recrear la tabla)`,
        );
      }
      if ((before.comment ?? '') !== (after.comment ?? '')) {
        plan.commentChanged = true;
        plan.changes.push(
          after.comment
            ? `Comentario de ${after.name} actualizado`
            : `Comentario de ${after.name} eliminado`,
        );
      }
    }

    for (const column of targetOnly) {
      plan.addedColumns.push(column);
      plan.changes.push(`Columna añadida: ${column.name} ${formatDataType(column)}`);
    }

    for (const column of baseOnly) {
      plan.removedColumns.push(column);
      touched.add(column.code);
      plan.changes.push(`Columna eliminada: ${column.name}`);
    }

    // La PK se rehace si cambian sus columnas o si se toca alguna de ellas.
    const pkBefore = primaryKeyCodes(fromTable);
    const pkAfter = primaryKeyCodes(toTable);
    const pkColumnTouched = pkAfter.some((code) => touched.has(code));
    plan.pkChanged = !sameSequence(pkBefore, pkAfter) || pkColumnTouched;
    if (plan.pkChanged) {
      plan.changes.push(
        pkBefore.length === 0
          ? `Clave primaria añadida: (${pkAfter.join(', ')})`
          : pkAfter.length === 0
            ? 'Clave primaria eliminada'
            : sameSequence(pkBefore, pkAfter)
              ? 'Clave primaria se reconstruye (cambia la definición de alguna de sus columnas)'
              : `Clave primaria: (${pkBefore.join(', ')}) → (${pkAfter.join(', ')})`,
      );
    }

    const {
      baseOnly: removedIndexes,
      targetOnly: newIndexes,
      paired: pairedIndexes,
    } = pairByCode(fromTable.indexes, toTable.indexes);

    for (const [before, after] of pairedIndexes) {
      if (
        before.name !== after.name ||
        before.unique !== after.unique ||
        !sameSequence(before.columns, after.columns)
      ) {
        plan.indexesToDrop.push({ name: before.name, reason: 'índice modificado' });
        plan.indexesToCreate.push({ name: after.name, reason: 'índice modificado' });
        plan.changes.push(`Índice ${before.name} → ${after.name}`);
      }
    }

    for (const index of removedIndexes) {
      plan.indexesToDrop.push({ name: index.name, reason: 'índice eliminado' });
      plan.changes.push(`Índice eliminado: ${index.name}`);
    }

    for (const index of newIndexes) {
      plan.indexesToCreate.push({ name: index.name, reason: 'índice nuevo' });
      plan.changes.push(`Índice nuevo: ${index.name}`);
    }

    // Un índice sobre una columna eliminada o modificada se vuelve a crear.
    for (const index of fromTable.indexes) {
      const covered = index.columns
        .map((columnId) => findColumn(fromTable, columnId)?.code)
        .filter((code): code is string => Boolean(code));
      if (!covered.some((code) => touched.has(code))) continue;
      if (plan.indexesToDrop.some((entry) => entry.name === index.name)) continue;
      plan.indexesToDrop.push({
        name: index.name,
        reason: covered.some((code) => renamed.has(code))
          ? 'cubre una columna renombrada'
          : 'cubre una columna modificada o eliminada',
      });
    }

    for (const index of toTable.indexes) {
      const covered = index.columns
        .map((columnId) => findColumn(toTable, columnId)?.code)
        .filter((code): code is string => Boolean(code));
      if (!covered.some((code) => touched.has(code))) continue;
      if (plan.indexesToCreate.some((entry) => entry.name === index.name)) continue;
      plan.indexesToCreate.push({ name: index.name, reason: 'cubre una columna modificada' });
    }

    // Claves alternativas (las que no son primarias). Sin esto, un DROP COLUMN
    // sobre una columna que entra en una UNIQUE falla en Oracle.
    const {
      baseOnly: removedKeys,
      targetOnly: newKeys,
      paired: pairedKeys,
    } = pairByCode(fromTable.keys, toTable.keys);

    const isAlternate = (key: (typeof fromTable.keys)[number]) => !key.isPrimary;

    for (const [before, after] of pairedKeys) {
      if (!isAlternate(before) || !isAlternate(after)) continue;
      if (before.name !== after.name || !sameSequence(before.columns, after.columns)) {
        plan.keysToDrop.push({ name: before.name, reason: 'clave alternativa modificada' });
        plan.keysToCreate.push({ name: after.name, reason: 'clave alternativa modificada' });
        plan.changes.push(`Clave alternativa ${before.name} → ${after.name}`);
      }
    }

    for (const key of removedKeys) {
      if (!isAlternate(key)) continue;
      plan.keysToDrop.push({ name: key.name, reason: 'clave alternativa eliminada' });
      plan.changes.push(`Clave alternativa eliminada: ${key.name}`);
    }

    for (const key of newKeys) {
      if (!isAlternate(key)) continue;
      plan.keysToCreate.push({ name: key.name, reason: 'clave alternativa nueva' });
      plan.changes.push(`Clave alternativa nueva: ${key.name}`);
    }

    for (const [source, targetTable, list] of [
      [fromTable, fromTable, plan.keysToDrop],
      [toTable, toTable, plan.keysToCreate],
    ] as const) {
      for (const key of source.keys) {
        if (!isAlternate(key)) continue;
        if (list.some((entry) => entry.name === key.name)) continue;
        const covered = key.columns
          .map((columnId) => findColumn(targetTable, columnId)?.code)
          .filter((code): code is string => Boolean(code));
        if (!covered.some((code) => touched.has(code))) continue;
        list.push({ name: key.name, reason: 'cubre una columna modificada o eliminada' });
      }
    }
  }

  for (const table of removedTables) {
    const plan = planOf(table, undefined);
    plan.kind = 'removed';
    plan.changes.push('Tabla eliminada');
  }

  for (const table of addedTables) {
    const plan = planOf(undefined, table);
    plan.kind = 'added';
    plan.changes.push(`Tabla añadida con ${table.columns.length} columna(s)`);
  }

  // --- Claves foráneas ------------------------------------------------------
  // Hay que soltar una FK si la tabla padre rehace su PK o toca columnas, si la
  // tabla hija toca sus propias columnas FK, o si la propia relación cambia.

  const parentsToDrop = new Set<string>();
  const childrenToDrop = new Set<string>();

  for (const plan of plans.values()) {
    if (plan.kind === 'added' || plan.kind === 'modified') {
      const structural = plan.pkChanged || plan.columnChanges.length > 0 || plan.removedColumns.length > 0;
      if (!structural) continue;
      parentsToDrop.add(plan.tableId);
      childrenToDrop.add(plan.tableId);
    }
    if (plan.kind === 'removed') {
      // Si desaparece la tabla padre, sus hijas siguen existiendo y la FK
      // impide el DROP TABLE: hay que soltarla antes.
      parentsToDrop.add(plan.tableId);
    }
  }

  const targetRefPairs = pairByCode(from.references, to.references);
  const targetRefByBaseId = new Map<string, Reference>();
  for (const [fromRef, toRef] of targetRefPairs.paired) {
    targetRefByBaseId.set(fromRef.id, toRef);
  }

  const references: ReferenceImpact[] = [];

  for (const reference of from.references) {
    const counterpart = targetRefByBaseId.get(reference.id);
    const touched = parentsToDrop.has(reference.parentTable) || childrenToDrop.has(reference.childTable);
    const changed =
      counterpart != null &&
      referenceSignature(reference, fromTables) !== referenceSignature(counterpart, toTables);
    const dropped = touched || counterpart == null || changed;

    if (dropped) {
      references.push({
        base: reference,
        target: counterpart,
        dropped: true,
        recreated: counterpart != null,
        note:
          counterpart == null
            ? 'FK eliminada'
            : changed
              ? 'FK modificada'
              : 'FK se elimina y recrea',
      });
    } else {
      references.push({ base: reference, target: counterpart, dropped: false, recreated: false, note: '' });
    }
  }

  for (const reference of targetRefPairs.targetOnly) {
    references.push({ base: undefined, target: reference, dropped: false, recreated: true, note: 'FK nueva' });
  }

  // --- Fases del script -----------------------------------------------------

  const sections = emptySections();
  let lossy = false;

  for (const plan of plans.values()) {
    const fromTable = plan.base;
    const toTable = plan.target;

    if (plan.kind === 'added' && toTable) {
      sections.tableOps.push(generateTableSql(toTable));
      continue;
    }
    if (plan.kind === 'removed' && fromTable) {
      sections.tableOps.push(`DROP TABLE ${escapeIdentifier(fromTable.name)};`);
      lossy = true;
      continue;
    }
    if (!fromTable || !toTable) continue;

    if (plan.pkChanged) {
      const pkColumns = toTable.columns
        .filter((column) => primaryKeyCodes(toTable).includes(column.code))
        .map((column) => escapeIdentifier(column.name));
      if (pkColumns.length > 0) {
        sections.preChecks.push(
          `-- Duplicados en la nueva PK de ${toTable.name} (debe devolver 0 filas):`,
          `--   SELECT ${pkColumns.join(', ')}, COUNT(*)`,
          `--     FROM ${escapeIdentifier(toTable.name)}`,
          `--    GROUP BY ${pkColumns.join(', ')} HAVING COUNT(*) > 1;`,
          '',
        );
      }
    }

    for (const index of plan.indexesToDrop) {
      sections.dropIndexes.push(`-- ${index.reason}`);
      sections.dropIndexes.push(`DROP INDEX ${escapeIdentifier(index.name)};`);
    }

    if (plan.pkChanged && primaryKeyCodes(fromTable).length > 0) {
      sections.dropPks.push(
        `ALTER TABLE ${escapeIdentifier(fromTable.name)} DROP CONSTRAINT ${escapeIdentifier(pkConstraintName(fromTable))};`,
      );
    }

    for (const key of plan.keysToDrop) {
      sections.dropPks.push(`-- ${key.reason}`);
      sections.dropPks.push(
        `ALTER TABLE ${escapeIdentifier(fromTable.name)} DROP CONSTRAINT ${escapeIdentifier(key.name)};`,
      );
    }

    if (fromTable.name !== toTable.name) {
      sections.tableOps.push(
        `ALTER TABLE ${escapeIdentifier(fromTable.name)} RENAME TO ${escapeIdentifier(toTable.name)};`,
      );
    }

    for (const change of plan.columnChanges) {
      if (change.renamed) {
        sections.columnOps.push(
          `ALTER TABLE ${escapeIdentifier(toTable.name)} RENAME COLUMN ${escapeIdentifier(change.before.name)} TO ${escapeIdentifier(change.after.name)};`,
        );
      }
      const parts: string[] = [];
      if (change.typeChanged) parts.push(formatDataType(change.after));
      if (change.defaultChanged) {
        const value = formatDefaultValue(change.after.defaultValue);
        if (value) parts.push(`DEFAULT ${value}`);
      }
      if (change.nullableChanged) parts.push(change.after.mandatory ? 'NOT NULL' : 'NULL');
      if (parts.length > 0) {
        sections.columnOps.push(
          `ALTER TABLE ${escapeIdentifier(toTable.name)} MODIFY (${escapeIdentifier(change.after.name)} ${parts.join(' ')});`,
        );
      }
      if ((change.before.comment ?? '') !== (change.after.comment ?? '')) {
        sections.commentOps.push(
          `COMMENT ON COLUMN ${escapeIdentifier(toTable.name)}.${escapeIdentifier(change.after.name)} IS ${quoteComment(change.after.comment)};`,
        );
      }
    }

    for (const column of plan.addedColumns) {
      const parts: string[] = [formatDataType(column)];
      const value = formatDefaultValue(column.defaultValue);
      if (value) parts.push(`DEFAULT ${value}`);
      if (column.mandatory) parts.push('NOT NULL');
      sections.columnOps.push(
        `ALTER TABLE ${escapeIdentifier(toTable.name)} ADD (${escapeIdentifier(column.name)} ${parts.join(' ')});`,
      );
    }

    for (const column of plan.removedColumns) {
      sections.columnOps.push(
        `ALTER TABLE ${escapeIdentifier(toTable.name)} DROP COLUMN ${escapeIdentifier(column.name)};`,
      );
      lossy = true;
    }

    if (plan.pkChanged) {
      const pkColumns = toTable.columns
        .filter((column) => primaryKeyCodes(toTable).includes(column.code))
        .map((column) => escapeIdentifier(column.name));
      if (pkColumns.length > 0) {
        sections.addPks.push(
          `ALTER TABLE ${escapeIdentifier(toTable.name)} ADD CONSTRAINT ${escapeIdentifier(pkConstraintName(toTable))} PRIMARY KEY (${pkColumns.join(', ')});`,
        );
      }
    }

    for (const keyChange of plan.keysToCreate) {
      const key = toTable.keys.find((entry) => entry.name === keyChange.name);
      if (!key) continue;
      const columns = key.columns
        .map((columnId) => findColumn(toTable, columnId)?.name)
        .filter((name): name is string => Boolean(name))
        .map((name) => escapeIdentifier(name));
      // Una clave alternativa que apunta a una columna que ya no existe no se
      // puede recrear: el modelo está inconsistente.
      if (columns.length === 0 || columns.length !== key.columns.length) continue;
      sections.addPks.push(
        `-- ${keyChange.reason}`,
        `ALTER TABLE ${escapeIdentifier(toTable.name)} ADD CONSTRAINT ${escapeIdentifier(key.name)} UNIQUE (${columns.join(', ')});`,
      );
    }

    for (const index of toTable.indexes) {
      if (!plan.indexesToCreate.some((entry) => entry.name === index.name)) continue;
      sections.createIndexes.push(generateIndexSql(toTable, index));
    }

    if ((fromTable.comment ?? '') !== (toTable.comment ?? '')) {
      sections.commentOps.push(
        `COMMENT ON TABLE ${escapeIdentifier(toTable.name)} IS ${quoteComment(toTable.comment)};`,
      );
    }
  }

  const droppedReferences = references.filter((reference) => reference.dropped && reference.base);
  for (const reference of droppedReferences) {
    const child = fromTables.get(reference.base!.childTable);
    if (!child) continue;
    sections.dropFks.push(
      `ALTER TABLE ${escapeIdentifier(child.name)} DROP CONSTRAINT ${escapeIdentifier(reference.base!.name)};`,
    );
  }

  for (const reference of references) {
    if (!reference.recreated || !reference.target) continue;
    const child = toTables.get(reference.target.childTable);
    const parent = toTables.get(reference.target.parentTable);
    const conditions = reference.target.joins
      .map((join) => {
        const childColumn = findColumn(child, join.childColumn);
        const parentColumn = findColumn(parent, join.parentColumn);
        if (!childColumn || !parentColumn) return '';
        return `p.${escapeIdentifier(parentColumn.name)} = c.${escapeIdentifier(childColumn.name)}`;
      })
      .filter(Boolean);
    const notNull = reference.target.joins
      .map((join) => {
        const childColumn = findColumn(child, join.childColumn);
        return childColumn ? `c.${escapeIdentifier(childColumn.name)} IS NOT NULL` : '';
      })
      .filter(Boolean);

    if (child && parent && conditions.length > 0) {
      sections.preChecks.push(
        `-- Huérfanos en ${child.name} hacia ${parent.name} (${reference.note}: debe devolver 0):`,
        `--   SELECT COUNT(*) FROM ${escapeIdentifier(child.name)} c`,
        `--    WHERE ${notNull.join(' AND ')}`,
        `--      AND NOT EXISTS (SELECT 1 FROM ${escapeIdentifier(parent.name)} p WHERE ${conditions.join(' AND ')});`,
        '',
      );
    }

    const sql = generateReferenceSql(reference.target, toTables);
    if (sql) sections.addFks.push(sql);
  }

  return { sections, impact: buildImpact(plans, references, fromTables), lossy };
}

function buildImpact(
  plans: Map<string, TablePlan>,
  references: ReferenceImpact[],
  fromTables: Map<string, Table>,
): TableImpact[] {
  const impact: TableImpact[] = [];

  for (const plan of plans.values()) {
    const childTables: ImpactedChild[] = [];
    const outgoingFks: string[] = [];

    for (const reference of references) {
      if (!reference.dropped || !reference.base) continue;
      if (reference.base.parentTable === plan.tableId) {
        const child = fromTables.get(reference.base.childTable);
        childTables.push({
          tableId: reference.base.childTable,
          name: child?.name ?? reference.base.childTable,
          reference: reference.base.name,
        });
      }
      if (reference.base.childTable === plan.tableId) {
        outgoingFks.push(reference.base.name);
      }
    }

    const indexes = [...plan.indexesToDrop, ...plan.keysToDrop].map((index) => index.name);
    if (
      plan.changes.length === 0 &&
      childTables.length === 0 &&
      outgoingFks.length === 0 &&
      indexes.length === 0
    ) {
      continue;
    }

    const kind: TableImpact['kind'] =
      plan.kind === 'added' || plan.kind === 'removed'
        ? plan.kind
        : plan.changes.length > 0 || indexes.length > 0
          ? 'modified'
          : 'affected';

    const changes = [...plan.changes];
    if (changes.length === 0) {
      for (const reference of references) {
        if (!reference.dropped || !reference.base) continue;
        if (reference.base.childTable !== plan.tableId) continue;
        const parent = fromTables.get(reference.base.parentTable);
        changes.push(
          `${reference.note}: ${reference.base.name} hacia ${parent?.name ?? reference.base.parentTable}`,
        );
      }
    }

    impact.push({
      tableId: plan.tableId,
      tableName: plan.target?.name ?? plan.base?.name ?? '',
      kind,
      changes,
      childTables,
      outgoingFks,
      indexes,
    });
  }

  return impact;
}

function renderScript(
  from: Model,
  to: Model,
  sections: PlanSections,
  options: { rollback: boolean; lossy: boolean },
): string {
  const blocks: string[] = [];
  let step = 0;

  const addBlock = (title: string, lines: string[]) => {
    if (lines.length === 0) return;
    step += 1;
    blocks.push(`-- ${step}. ${title}\n${lines.join('\n').replace(/\s+$/, '')}`);
  };

  const header = [
    '-- ==========================================================================',
    `-- Script de ${options.rollback ? 'rollback' : 'migración'} Oracle · ${from.name} → ${to.name}`,
    `-- Generado por PDM Viewer a partir del diff de dos ficheros .pdm.`,
    '-- Orden fijo: FKs → índices → PKs → tablas → columnas → PKs → índices → FKs.',
    '-- Los nombres de constraints salen del modelo: contrasta con la base de datos antes de ejecutar.',
  ];
  if (options.rollback && options.lossy) {
    header.push(
      '-- AVISO: el script directo eliminaba columnas o tablas. El rollback recrea la',
      '-- estructura vacía, pero los datos que se perdieron NO se recuperan.',
    );
  }
  header.push('-- ==========================================================================');

  blocks.push(header.join('\n'));

  addBlock('Prevalidación (descomenta y ejecuta antes de continuar)', sections.preChecks);
  addBlock('Eliminar las claves foráneas afectadas', sections.dropFks);
  addBlock('Eliminar los índices afectados', sections.dropIndexes);
  addBlock('Eliminar las claves modificadas (primarias y alternativas)', sections.dropPks);
  addBlock('Tablas: renombrar, crear y eliminar', sections.tableOps);
  addBlock('Columnas: renombrar, modificar, añadir y eliminar', sections.columnOps);
  addBlock('Crear las claves nuevas (primarias y alternativas)', sections.addPks);
  addBlock('Crear los índices nuevos', sections.createIndexes);
  addBlock('Recrear las claves foráneas', sections.addFks);
  addBlock('Comentarios', sections.commentOps);

  if (step === 0) {
    return `${blocks[0]}\n\n-- No hay cambios que aplicar entre los dos modelos.`;
  }

  return blocks.join('\n\n');
}

function countStatements(sql: string): number {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--')).length;
}

export function generateMigration(base: Model, target: Model): MigrationScript {
  const forward = analyze(base, target);
  const backward = analyze(target, base);

  const forwardSql = renderScript(base, target, forward.sections, { rollback: false, lossy: false });
  const rollbackSql = renderScript(target, base, backward.sections, {
    rollback: true,
    lossy: forward.lossy,
  });

  return {
    forward: forwardSql,
    rollback: rollbackSql,
    impact: forward.impact,
    statementCount: countStatements(forwardSql),
    rollbackStatementCount: countStatements(rollbackSql),
  };
}
