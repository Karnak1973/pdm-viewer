/**
 * Recurso de migración Oracle dentro de la pestaña de diff.
 *
 * A partir del modelo cargado y del .pdm de comparación genera el script
 * ordenado para actualizar la base de datos, el script inverso y el
 * listado de tablas afectadas.
 */

import { useMemo, useState } from 'react';
import type { Model } from '../../model/types';
import { useModelStore } from '../../state/modelStore';
import { generateMigration, type TableImpact } from '../../utils/migrationScript';
import { downloadFile } from '../../utils/reportExport';

type Tab = 'impacto' | 'script' | 'rollback';

const KIND_LABEL: Record<TableImpact['kind'], string> = {
  modified: 'Modificada',
  added: 'Añadida',
  removed: 'Eliminada',
  affected: 'Afectada',
};

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '') || 'modelo';
}

export function MigrationSection({ model, targetModel }: { model: Model; targetModel: Model }) {
  const setSelectedTable = useModelStore((state) => state.setSelectedTable);
  const setView = useModelStore((state) => state.setView);

  const [tab, setTab] = useState<Tab>('impacto');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  const migration = useMemo(() => generateMigration(model, targetModel), [model, targetModel]);
  const isRollback = tab === 'rollback';
  const sql = isRollback ? migration.rollback : migration.forward;
  const statements = isRollback ? migration.rollbackStatementCount : migration.statementCount;

  const openTable = (tableId: string) => {
    setSelectedTable(tableId);
    setView('diagram');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1200);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 1500);
    }
  };

  const handleDownload = () => {
    const prefix = isRollback ? 'rollback' : 'migracion';
    downloadFile(sql, `${prefix}-${slug(model.name)}-a-${slug(targetModel.name)}.sql`, 'text/plain');
  };

  return (
    <div className="migration">
      <header className="migration__header">
        <div>
          <p className="eyebrow">Migración</p>
          <h3>Script de actualización para Oracle</h3>
          <p className="migration__hint">
            Las claves foráneas hijas se sueltan antes de tocar la clave primaria, y se vuelven a
            crear al final. Las comprobaciones de duplicados y de filas huérfanas vienen
            comentadas: descoméntalas y ejecútalas antes de aplicar nada.
          </p>
        </div>

        <div className="migration__actions">
          <div className="migration__switch" role="tablist" aria-label="Vista de la migración">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'impacto'}
              className={tab === 'impacto' ? 'active' : ''}
              onClick={() => setTab('impacto')}
            >
              Impacto
              {migration.impact.length > 0 ? (
                <span className="migration__badge">{migration.impact.length}</span>
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'script'}
              className={tab === 'script' ? 'active' : ''}
              onClick={() => setTab('script')}
            >
              Script
              {migration.statementCount > 0 ? (
                <span className="migration__badge">{migration.statementCount}</span>
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'rollback'}
              className={tab === 'rollback' ? 'active' : ''}
              onClick={() => setTab('rollback')}
            >
              Rollback
              {migration.rollbackStatementCount > 0 ? (
                <span className="migration__badge">{migration.rollbackStatementCount}</span>
              ) : null}
            </button>
          </div>

          {tab !== 'impacto' ? (
            <div className="migration__buttons">
              <button type="button" onClick={handleCopy}>
                {copyState === 'copied' ? 'Copiado' : copyState === 'error' ? 'Error' : 'Copiar SQL'}
              </button>
              <button type="button" onClick={handleDownload}>
                Descargar .sql
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {tab === 'impacto' ? (
        migration.impact.length === 0 ? (
          <p className="migration__empty">Ningún cambio que impacte en la base de datos.</p>
        ) : (
          <ul className="migration__impact">
            {migration.impact.map((entry) => (
              <li key={`${entry.kind}-${entry.tableId}`} className={`migration__item ${entry.kind}`}>
                <div className="migration__item-top">
                  <span className={`migration__kind ${entry.kind}`}>{KIND_LABEL[entry.kind]}</span>
                  <strong>{entry.tableName}</strong>
                  {entry.kind !== 'added' ? (
                    <button type="button" className="migration__open" onClick={() => openTable(entry.tableId)}>
                      Ver tabla
                    </button>
                  ) : null}
                </div>

                {entry.changes.length > 0 ? (
                  <ul className="migration__changes">
                    {entry.changes.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                ) : null}

                {entry.childTables.length > 0 ? (
                  <p className="migration__meta">
                    Tablas hijas ({entry.childTables.length}):
                    {entry.childTables.map((child) => (
                      <button
                        key={`${child.reference}-${child.tableId}`}
                        type="button"
                        className="migration__chip"
                        onClick={() => openTable(child.tableId)}
                        title={`Se elimina y recrea la FK ${child.reference}`}
                      >
                        {child.name}
                      </button>
                    ))}
                  </p>
                ) : null}

                {entry.outgoingFks.length > 0 ? (
                  <p className="migration__meta">
                    Claves foráneas salientes: {entry.outgoingFks.join(', ')}
                  </p>
                ) : null}

                {entry.indexes.length > 0 ? (
                  <p className="migration__meta">Índices que se rehacen: {entry.indexes.join(', ')}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : (
        <>
          <p className="migration__hint">
            {statements} sentencia(s) {isRollback ? 'para deshacer el cambio' : 'para aplicar el cambio'}.
            {isRollback
              ? ' El rollback devuelve la estructura anterior; los datos eliminados no se recuperan.'
              : ' Revísalas antes de ejecutarlas contra la base de datos.'}
          </p>
          <pre className="migration__code">{sql}</pre>
        </>
      )}
    </div>
  );
}
