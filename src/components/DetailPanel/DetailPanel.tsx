import { useState } from 'react';
import { useModelStore } from '../../state/modelStore';
import { generateModelSql, generateTableSql } from '../../utils/sqlGenerator';

function formatSqlForDisplay(sql: string) {
  return sql
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line, index) => (
      <span key={`${line}-${index}`} className="sql-line">
        {line}
      </span>
    ));
}

export function DetailPanel() {
  const { model, selectedTableId } = useModelStore();
  const [viewMode, setViewMode] = useState<'details' | 'sql' | 'model'>('details');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  const selectedTable = model.tables.find((table) => table.id === selectedTableId) ?? model.tables[0];

  if (!selectedTable) {
    return <section className="detail-panel empty">No hay tabla seleccionada.</section>;
  }

  const incoming = model.references.filter((reference) => reference.childTable === selectedTable.id);
  const outgoing = model.references.filter((reference) => reference.parentTable === selectedTable.id);
  const tableSql = generateTableSql(selectedTable);
  const modelSql = generateModelSql(model);

  const handleCopy = async () => {
    const text = viewMode === 'model' ? modelSql : tableSql;

    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1200);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 1500);
    }
  };

  return (
    <section className="detail-panel">
      <header className="detail-panel__header">
        <div>
          <p className="eyebrow">Tabla</p>
          <h2>{selectedTable.name}</h2>
        </div>
        <div className="detail-panel__actions">
          <div className="detail-panel__switch" aria-label="Cambiar vista de detalles">
            <button
              type="button"
              className={viewMode === 'details' ? 'active' : ''}
              onClick={() => setViewMode('details')}
            >
              Detalles
            </button>
            <button
              type="button"
              className={viewMode === 'sql' ? 'active' : ''}
              onClick={() => setViewMode('sql')}
            >
              SQL
            </button>
            <button
              type="button"
              className={viewMode === 'model' ? 'active' : ''}
              onClick={() => setViewMode('model')}
            >
              Modelo
            </button>
          </div>
          <button type="button" className="copy-button" onClick={handleCopy}>
            {copyState === 'copied' ? 'Copiado' : copyState === 'error' ? 'Error' : 'Copiar SQL'}
          </button>
          <span className="badge">{selectedTable.code}</span>
        </div>
      </header>

      {selectedTable.comment ? <p className="detail-panel__comment">{selectedTable.comment}</p> : null}

      {viewMode === 'sql' || viewMode === 'model' ? (
        <div className="sql-header">Oracle DDL</div>
      ) : null}

      {viewMode === 'sql' ? (
        <div className="sql-view">
          <pre>{formatSqlForDisplay(tableSql)}</pre>
        </div>
      ) : viewMode === 'model' ? (
        <div className="sql-view">
          <pre>{formatSqlForDisplay(modelSql)}</pre>
        </div>
      ) : (
        <div className="detail-grid">
          <div>
            <h3>Columnas</h3>
            <ul className="key-list">
              {selectedTable.columns.map((column) => {
                const isPk = selectedTable.primaryKey?.includes(column.id) ?? false;
                const isFk = model.references.some(
                  (reference) =>
                    reference.childTable === selectedTable.id &&
                    reference.joins.some((join) => join.childColumn === column.id),
                );

                return (
                  <li key={column.id} className={isPk ? 'key-list__item pk' : isFk ? 'key-list__item fk' : 'key-list__item'}>
                    <div className="key-list__title">
                      <span className="entity-badge">{isPk ? 'PK' : isFk ? 'FK' : 'C'}</span>
                      <strong>{column.name}</strong>
                    </div>
                    <span>
                      {column.dataType}
                      {column.length ? `(${column.length})` : ''}
                    </span>
                    <div className="nullability-row">
                      <small className={column.mandatory ? 'nullability not-null' : 'nullability nullable'}>
                        {column.mandatory ? 'NOT NULL' : 'NULL'}
                      </small>
                      {column.identity ? <small className="nullability identity">IDENTITY</small> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <div>
            <h3>PK / Claves</h3>
            <ul className="key-list">
              {selectedTable.keys.map((key) => (
                <li key={key.id} className={key.isPrimary ? 'key-list__item pk' : 'key-list__item'}>
                  <div className="key-list__title">
                    <span className="entity-badge primary">{key.isPrimary ? 'PK' : 'K'}</span>
                    <strong>{key.name}</strong>
                  </div>
                  <span>{key.columns.join(', ') || '—'}</span>
                  <small>{key.isPrimary ? 'Primary key' : 'Alternate key'}</small>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3>Índices</h3>
            <ul className="key-list">
              {selectedTable.indexes.map((index) => (
                <li key={index.id} className="key-list__item index">
                  <div className="key-list__title">
                    <span className="entity-badge index">IDX</span>
                    <strong>{index.name}</strong>
                  </div>
                  <span>{index.columns.join(', ') || '—'}</span>
                  <small>{index.unique ? 'Unique' : 'Non-unique'}</small>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3>Relaciones</h3>
            <ul className="key-list compact">
              {incoming.map((reference) => (
                <li key={reference.id} className="key-list__item fk">
                  <div className="key-list__title">
                    <span className="entity-badge fk">FK</span>
                    <strong>FK entrante</strong>
                  </div>
                  <span>{reference.name}</span>
                  <small>{reference.parentTable}</small>
                </li>
              ))}
              {outgoing.map((reference) => (
                <li key={reference.id} className="key-list__item fk">
                  <div className="key-list__title">
                    <span className="entity-badge fk">FK</span>
                    <strong>FK saliente</strong>
                  </div>
                  <span>{reference.name}</span>
                  <small>{reference.childTable}</small>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
