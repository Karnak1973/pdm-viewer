import { describe, expect, it } from 'vitest';
import type { Column, Model, Reference, Table } from '../model/types';
import { generateMigration } from './migrationScript';

let counter = 0;
function col(code: string, opts: Partial<Column> = {}): Column {
  counter += 1;
  return {
    id: `col-${code}`,
    pdId: `pd-${code}`,
    code,
    name: code,
    dataType: 'VARCHAR2',
    length: 50,
    mandatory: true,
    identity: false,
    ...opts,
  };
}

function table(code: string, opts: Partial<Table> = {}): Table {
  const columns = opts.columns ?? [col(`${code}_ID`)];
  return {
    id: `table-${code}`,
    pdId: `pdtable-${code}`,
    code,
    name: code,
    columns,
    primaryKey: opts.primaryKey ?? [columns[0].id],
    keys: opts.keys ?? [
      { id: `key-${code}`, pdId: `pdkey-${code}`, name: `PK_${code}`, columns: opts.primaryKey ?? [columns[0].id], isPrimary: true },
    ],
    indexes: opts.indexes ?? [],
  };
}

function ref(name: string, parent: Table, child: Table, joins: [string, string][]): Reference {
  return {
    id: `ref-${name}`,
    pdId: `pdref-${name}`,
    name,
    parentTable: parent.id,
    childTable: child.id,
    joins: joins.map(([parentColumn, childColumn]) => ({ parentColumn, childColumn })),
    cardinality: '1:N',
  };
}

function model(tables: Table[], references: Reference[] = []): Model {
  return { name: 'M', tables, references, domains: [] };
}

function indexOf(text: string, needle: string): number {
  return text.indexOf(needle);
}

/** Monta el caso real: dos padres con PK de tres columnas y sus hijas. */
function escenario() {
  counter = 0;

  const cabecera = () => table('CABECERA', {
    columns: [col('CAB_ID'), col('CAB_GESTION'), col('CAB_FECHA', { dataType: 'DATE', length: undefined, mandatory: false })],
    primaryKey: ['col-CAB_ID', 'col-CAB_GESTION', 'col-CAB_FECHA'],
    indexes: [{ id: 'idx-cab', name: 'IX_CAB_GESTION', columns: ['col-CAB_GESTION'], unique: false }],
  });
  const detalle = () => table('DETALLE', {
    columns: [col('DET_ID'), col('DET_CAB_ID'), col('DET_CAB_GESTION'), col('DET_CAB_FECHA', { dataType: 'DATE', length: undefined, mandatory: false })],
    primaryKey: ['col-DET_ID'],
    indexes: [{ id: 'idx-det', name: 'IX_DET_CAB', columns: ['col-DET_CAB_ID', 'col-DET_CAB_GESTION'], unique: false }],
  });

  const cabeceraAntes = cabecera();
  const detalleAntes = detalle();
  const cabeceraFK = ref('FK_CAB_DET', cabeceraAntes, detalleAntes, [
    ['col-CAB_ID', 'col-DET_CAB_ID'],
    ['col-CAB_GESTION', 'col-DET_CAB_GESTION'],
    ['col-CAB_FECHA', 'col-DET_CAB_FECHA'],
  ]);

  return { cabecera: cabeceraAntes, detalle: detalleAntes, cabeceraFK };
}

describe('generateMigration — cambio de clave primaria', () => {
  it('suelta las FKs hijas antes de tocar la PK y las recrea al final', () => {
    const { cabecera, detalle, cabeceraFK } = escenario();

    // Se cambia un campo de la PK padre: la fecha pasa de DATE a VARCHAR2(20).
    const cabeceraDespues: Table = {
      ...cabecera,
      columns: cabecera.columns.map((column) =>
        column.code === 'CAB_FECHA'
          ? { ...column, dataType: 'VARCHAR2', length: 20, mandatory: true }
          : column,
      ),
    };
    const detalleDespues: Table = {
      ...detalle,
      columns: detalle.columns.map((column) =>
        column.code === 'DET_CAB_FECHA' ? { ...column, dataType: 'VARCHAR2', length: 20 } : column,
      ),
    };
    const cabeceraFKDespues: Reference = { ...cabeceraFK, childTable: detalleDespues.id };
    cabeceraFKDespues.joins = [
      { parentColumn: 'col-CAB_ID', childColumn: 'col-DET_CAB_ID' },
      { parentColumn: 'col-CAB_GESTION', childColumn: 'col-DET_CAB_GESTION' },
      { parentColumn: 'col-CAB_FECHA', childColumn: 'col-DET_CAB_FECHA' },
    ];

    const sql = generateMigration(
      model([cabecera, detalle], [cabeceraFK]),
      model([cabeceraDespues, detalleDespues], [cabeceraFKDespues]),
    ).forward;

    const dropFk = indexOf(sql, 'ALTER TABLE "DETALLE" DROP CONSTRAINT "FK_CAB_DET"');
    const dropPk = indexOf(sql, 'ALTER TABLE "CABECERA" DROP CONSTRAINT "PK_CABECERA"');
    const modify = indexOf(sql, 'MODIFY ("CAB_FECHA"');
    const addPk = indexOf(sql, 'ADD CONSTRAINT "PK_CABECERA" PRIMARY KEY');
    const addFk = indexOf(sql, 'ADD CONSTRAINT "FK_CAB_DET" FOREIGN KEY');

    expect(dropFk).toBeGreaterThan(-1);
    expect(dropPk).toBeGreaterThan(-1);
    expect(addPk).toBeGreaterThan(-1);
    expect(addFk).toBeGreaterThan(-1);

    // Orden obligatorio para Oracle.
    expect(dropFk).toBeLessThan(dropPk);
    expect(dropPk).toBeLessThan(modify);
    expect(modify).toBeLessThan(addPk);
    expect(addPk).toBeLessThan(addFk);
  });

  it('rehace el índice que cubre la columna tocada en la tabla padre', () => {
    const { cabecera, detalle, cabeceraFK } = escenario();

    const cabeceraDespues: Table = {
      ...cabecera,
      columns: cabecera.columns.map((column) =>
        column.code === 'CAB_GESTION' ? { ...column, length: 120 } : column,
      ),
    };

    const sql = generateMigration(model([cabecera, detalle], [cabeceraFK]), model([cabeceraDespues, detalle])).forward;

    expect(sql).toContain('DROP INDEX "IX_CAB_GESTION";');
    expect(sql).toContain('CREATE INDEX "IX_CAB_GESTION"');
    // El índice se suelta antes de la PK.
    expect(indexOf(sql, 'DROP INDEX "IX_CAB_GESTION"')).toBeLessThan(
      indexOf(sql, 'DROP CONSTRAINT "PK_CABECERA"'),
    );
  });

  it('no toca los índices de la hija si sus columnas FK no cambian', () => {
    const { cabecera, detalle, cabeceraFK } = escenario();

    const cabeceraDespues: Table = {
      ...cabecera,
      columns: cabecera.columns.map((column) =>
        column.code === 'CAB_GESTION' ? { ...column, length: 120 } : column,
      ),
    };

    const sql = generateMigration(model([cabecera, detalle], [cabeceraFK]), model([cabeceraDespues, detalle])).forward;

    // IX_DET_CAB cubre DET_CAB_ID y DET_CAB_GESTION, que no cambian: sigue siendo
    // válido, aunque su FK se elimina y vuelva a crear.
    expect(sql).not.toContain('IX_DET_CAB');
  });

  it('incluye la comprobación de duplicados de la PK como prevalidación comentada', () => {
    const { cabecera, detalle, cabeceraFK } = escenario();
    const cabeceraDespues: Table = {
      ...cabecera,
      primaryKey: ['col-CAB_ID', 'col-CAB_GESTION'],
      keys: [
        { id: 'key-CABECERA', pdId: 'pdkey-CABECERA', name: 'PK_CABECERA', columns: ['col-CAB_ID', 'col-CAB_GESTION'], isPrimary: true },
      ],
    };

    const { forward } = generateMigration(
      model([cabecera, detalle], [cabeceraFK]),
      model([cabeceraDespues, detalle], [cabeceraFK]),
    );

    expect(forward).toContain('Duplicados en la nueva PK de CABECERA');
    expect(forward).toContain('GROUP BY "CAB_ID", "CAB_GESTION" HAVING COUNT(*) > 1');
  });

  it('comprueba los huérfanos de cada FK recreada', () => {
    const { cabecera, detalle, cabeceraFK } = escenario();

    // Cambia una columna FK de la hija: la FK se suelta y se recrea.
    const detalleDespues: Table = {
      ...detalle,
      columns: detalle.columns.map((column) =>
        column.code === 'DET_CAB_GESTION' ? { ...column, length: 120 } : column,
      ),
    };

    const { forward } = generateMigration(
      model([cabecera, detalle], [cabeceraFK]),
      model([cabecera, detalleDespues], [cabeceraFK]),
    );

    expect(forward).toContain('DROP CONSTRAINT "FK_CAB_DET"');
    expect(forward).toContain('Huérfanos en DETALLE hacia CABECERA');
    expect(forward).toContain('NOT EXISTS (SELECT 1 FROM "CABECERA" p');
  });
});

describe('generateMigration — renombrados', () => {
  it('detecta el renombrado de una columna y genera RENAME COLUMN en vez de drop+add', () => {
    counter = 0;
    const antes = table('USUARIO', { columns: [col('USR_ID'), col('USR_COD', { length: 10 })] });
    const despues: Table = {
      ...antes,
      columns: [
        { ...antes.columns[0] },
        { ...antes.columns[1], name: 'USR_CODIGO' },
      ],
    };

    const { forward, impact } = generateMigration(model([antes]), model([despues]));

    expect(forward).toContain('ALTER TABLE "USUARIO" RENAME COLUMN "USR_COD" TO "USR_CODIGO";');
    expect(forward).not.toContain('DROP COLUMN "USR_COD"');
    expect(impact[0].changes).toContain('Columna renombrada: USR_COD → USR_CODIGO');
  });

  it('renombra la tabla y usa el nombre nuevo en las sentencias posteriores', () => {
    counter = 0;
    const antes = table('VENTAS', { columns: [col('V_ID'), col('V_TOTAL', { dataType: 'NUMBER', length: undefined })] });
    const despues: Table = {
      ...antes,
      name: 'PEDIDOS',
      columns: [{ ...antes.columns[0] }, { ...antes.columns[1], length: 12, precision: 2 }],
      primaryKey: ['col-V_ID', 'col-V_TOTAL'],
      keys: [
        { id: 'key-VENTAS', pdId: 'pdkey-VENTAS', name: 'PK_PEDIDOS', columns: ['col-V_ID', 'col-V_TOTAL'], isPrimary: true },
      ],
    };

    const { forward } = generateMigration(model([antes]), model([despues]));

    expect(forward).toContain('ALTER TABLE "VENTAS" RENAME TO "PEDIDOS";');
    // El DROP va contra el nombre y la constraint antiguos...
    expect(indexOf(forward, 'DROP CONSTRAINT "PK_VENTAS"')).toBeLessThan(
      indexOf(forward, 'RENAME TO "PEDIDOS"'),
    );
    // ...y todo lo posterior, contra los nuevos.
    expect(indexOf(forward, 'RENAME TO "PEDIDOS"')).toBeLessThan(
      indexOf(forward, 'MODIFY ("V_TOTAL"'),
    );
    expect(indexOf(forward, 'RENAME TO "PEDIDOS"')).toBeLessThan(
      indexOf(forward, 'ADD CONSTRAINT "PK_PEDIDOS" PRIMARY KEY ("V_ID", "V_TOTAL")'),
    );
  });
});

describe('generateMigration — ciclo completo de esquema', () => {
  it('cubre altas, bajas y modificaciones de columnas', () => {
    counter = 0;
    const antes = table('ARTICULO', {
      columns: [col('ART_ID'), col('ART_NOMBRE', { length: 40 }), col('ART_OBS', { mandatory: false })],
      indexes: [{ id: 'ix', name: 'IX_ART_NOMBRE', columns: ['col-ART_NOMBRE'], unique: true }],
    });
    const despues: Table = {
      ...antes,
      columns: [
        { ...antes.columns[0] },
        { ...antes.columns[1], length: 80 },
        col('ART_CODIGO', { length: 15 }),
      ],
      indexes: [{ id: 'ix', name: 'IX_ART_NOMBRE', columns: ['col-ART_NOMBRE'], unique: true }],
    };

    const { forward, statementCount } = generateMigration(model([antes]), model([despues]));

    expect(forward).toContain('ALTER TABLE "ARTICULO" MODIFY ("ART_NOMBRE" VARCHAR2(80));');
    expect(forward).toContain('ALTER TABLE "ARTICULO" ADD ("ART_CODIGO" VARCHAR2(15) NOT NULL);');
    expect(forward).toContain('ALTER TABLE "ARTICULO" DROP COLUMN "ART_OBS";');
    expect(statementCount).toBeGreaterThan(2);
  });

  it('crea las tablas nuevas con su PK e índices y les añade las FKs', () => {
    counter = 0;
    const padre = table('PADRE', { columns: [col('PAD_ID')] });
    const padreDespues: Table = {
      ...padre,
      columns: [col('PAD_COD')],
      primaryKey: ['col-PAD_COD'],
      keys: [{ id: 'key-P', name: 'PK_PADRE', columns: ['col-PAD_COD'], isPrimary: true }],
    };

    const { forward } = generateMigration(model([padre]), model([padreDespues]));
    expect(forward).not.toContain('CREATE TABLE');

    counter = 0;
    const padre2 = table('PADRE', { columns: [col('PAD_ID')] });
    const nueva = table('HIJA', {
      columns: [col('HIJ_ID'), col('HIJ_PAD_ID')],
      indexes: [{ id: 'ix2', name: 'IX_HIJ_PAD', columns: ['col-HIJ_PAD_ID'], unique: false }],
    });
    const fk: Reference = {
      id: 'ref1',
      name: 'FK_HIJ_PAD',
      parentTable: padre2.id,
      childTable: nueva.id,
      joins: [{ parentColumn: 'col-PAD_ID', childColumn: 'col-HIJ_PAD_ID' }],
      cardinality: '1:N',
    };

    const result = generateMigration(model([padre2]), model([padre2, nueva], [fk]));
    expect(result.forward).toContain('CREATE TABLE "HIJA"');
    expect(result.forward).toContain('CONSTRAINT "PK_HIJA" PRIMARY KEY ("HIJ_ID")');
    expect(result.forward).toContain('CREATE INDEX "IX_HIJ_PAD"');
    expect(result.forward).toContain('ADD CONSTRAINT "FK_HIJ_PAD" FOREIGN KEY ("HIJ_PAD_ID")');
    expect(result.impact.some((entry) => entry.kind === 'added' && entry.tableName === 'HIJA')).toBe(true);
  });

  it('suelta y rehace las claves alternativas que cubren una columna eliminada', () => {
    counter = 0;
    const antes = table('CLIENTE', {
      columns: [col('CLI_ID'), col('CLI_NIF')],
      keys: [
        { id: 'k1', name: 'PK_CLIENTE', columns: ['col-CLI_ID'], isPrimary: true },
        { id: 'k2', name: 'AK_CLIENTE_NIF', columns: ['col-CLI_NIF'], isPrimary: false },
      ],
    });
    const despues: Table = { ...antes, columns: [antes.columns[0]] };

    const { forward } = generateMigration(model([antes]), model([despues]));

    expect(forward).toContain('ALTER TABLE "CLIENTE" DROP CONSTRAINT "AK_CLIENTE_NIF";');
    expect(indexOf(forward, 'DROP CONSTRAINT "AK_CLIENTE_NIF"')).toBeLessThan(
      indexOf(forward, 'DROP COLUMN "CLI_NIF"'),
    );
    // El modelo todavía declara la clave, pero su columna ya no existe: no se
    // emite un UNIQUE con la lista de columnas vacía.
    expect(forward).not.toContain('ADD CONSTRAINT "AK_CLIENTE_NIF" UNIQUE');
  });

  it('elimina las tablas retiradas soltando antes las FKs que las apuntan', () => {
    counter = 0;
    const padre = table('PADRE', { columns: [col('PAD_ID')] });
    const hija = table('HIJA', {
      columns: [col('HIJ_ID'), col('HIJ_PAD_ID')],
    });
    const fk: Reference = {
      id: 'ref1',
      name: 'FK_HIJ_PAD',
      parentTable: padre.id,
      childTable: hija.id,
      joins: [{ parentColumn: 'col-PAD_ID', childColumn: 'col-HIJ_PAD_ID' }],
      cardinality: '1:N',
    };

    const { forward } = generateMigration(model([padre, hija], [fk]), model([hija], []));

    expect(forward).toContain('ALTER TABLE "HIJA" DROP CONSTRAINT "FK_HIJ_PAD";');
    expect(indexOf(forward, 'DROP CONSTRAINT "FK_HIJ_PAD"')).toBeLessThan(
      indexOf(forward, 'DROP TABLE "PADRE"'),
    );
  });

  it('sustituye una FK por una nueva cuando cambian sus columnas', () => {
    counter = 0;
    const padre = table('PADRE', { columns: [col('PAD_ID'), col('PAD_COD')] });
    const hija = table('HIJA', { columns: [col('HIJ_ID'), col('HIJ_PAD_ID')] });
    const fk: Reference = {
      id: 'ref1',
      name: 'FK_HIJ_PAD',
      parentTable: padre.id,
      childTable: hija.id,
      joins: [{ parentColumn: 'col-PAD_ID', childColumn: 'col-HIJ_PAD_ID' }],
      cardinality: '1:N',
    };
    const fkDespues: Reference = { ...fk, joins: [{ parentColumn: 'col-PAD_COD', childColumn: 'col-HIJ_PAD_ID' }] };

    const { forward, impact } = generateMigration(model([padre, hija], [fk]), model([padre, hija], [fkDespues]));

    expect(forward).toContain('DROP CONSTRAINT "FK_HIJ_PAD"');
    expect(forward).toContain('REFERENCES "PADRE" ("PAD_COD")');
    expect(impact.find((entry) => entry.tableName === 'HIJA')?.changes.join(' ')).toContain('FK modificada');
  });
});

describe('generateMigration — informe de impacto', () => {
  it('lista las tablas hijas y los índices afectados por el cambio de PK', () => {
    const { cabecera, detalle, cabeceraFK } = escenario();
    const cabeceraDespues: Table = {
      ...cabecera,
      primaryKey: ['col-CAB_ID', 'col-CAB_GESTION'],
      keys: [
        { id: 'key-CABECERA', pdId: 'pdkey-CABECERA', name: 'PK_CABECERA', columns: ['col-CAB_ID', 'col-CAB_GESTION'], isPrimary: true },
      ],
    };

    const { impact } = generateMigration(model([cabecera, detalle], [cabeceraFK]), model([cabeceraDespues, detalle], [cabeceraFK]));

    const padreImpacto = impact.find((entry) => entry.tableName === 'CABECERA');
    expect(padreImpacto).toBeDefined();
    expect(padreImpacto!.childTables).toEqual([
      { tableId: 'table-DETALLE', name: 'DETALLE', reference: 'FK_CAB_DET' },
    ]);
    expect(padreImpacto!.changes.join(' ')).toContain('Clave primaria: (CAB_ID, CAB_GESTION, CAB_FECHA) → (CAB_ID, CAB_GESTION)');

    const hijaImpacto = impact.find((entry) => entry.tableName === 'DETALLE');
    expect(hijaImpacto).toBeDefined();
    expect(hijaImpacto!.outgoingFks).toContain('FK_CAB_DET');
    expect(hijaImpacto!.kind).toBe('affected');
  });
});

describe('generateMigration — rollback', () => {
  it('devuelve el espejo del script directo', () => {
    counter = 0;
    const antes = table('VENTA', { columns: [col('V_ID'), col('V_TOTAL', { dataType: 'NUMBER', length: undefined })] });
    const despues: Table = {
      ...antes,
      columns: [{ ...antes.columns[0] }, { ...antes.columns[1], dataType: 'NUMBER', length: 12, precision: 2 }],
    };

    const { forward, rollback } = generateMigration(model([antes]), model([despues]));

    expect(forward).toContain('MODIFY ("V_TOTAL" NUMBER(12, 2))');
    expect(rollback).toContain('Script de rollback Oracle');
    expect(rollback).toContain('MODIFY ("V_TOTAL" NUMBER)');
  });

  it('avisa de que los datos de las columnas eliminadas no se recuperan', () => {
    counter = 0;
    const antes = table('VENTA', { columns: [col('V_ID'), col('V_OBS', { mandatory: false })] });
    const despues: Table = { ...antes, columns: [antes.columns[0]] };

    const { rollback } = generateMigration(model([antes]), model([despues]));

    expect(rollback).toContain('AVISO');
    expect(rollback).toContain('los datos que se perdieron NO se recuperan');
  });

  it('indica que no hay cambios entre modelos idénticos', () => {
    counter = 0;
    const m = model([table('IGUAL', { columns: [col('I_ID')] })]);
    const { forward, statementCount } = generateMigration(m, m);
    expect(statementCount).toBe(0);
    expect(forward).toContain('No hay cambios que aplicar');
  });
});
