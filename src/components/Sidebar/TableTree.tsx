import { useMemo, useState } from 'react';
import { useSemanticSearch } from '../../hooks/useSemanticSearch';
import { EXTERNAL_AI_HOST } from '../../ml/buildConfig';
import { useModelStore } from '../../state/modelStore';

type SearchModeToggle = 'text' | 'semantic';

export function TableTree() {
  const { model, selectedTableId, search, setSelectedTable, setSearch } = useModelStore();
  const [mode, setMode] = useState<SearchModeToggle>('text');

  const semantic = useSemanticSearch(model, mode === 'semantic', search);

  const filteredTables = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return model.tables;

    return model.tables.filter((table) => {
      const haystack = `${table.name} ${table.code} ${table.columns
        .map((column) => `${column.name} ${column.code}`)
        .join(' ')}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [model.tables, search]);

  const semanticTables = useMemo(() => {
    if (mode !== 'semantic' || !semantic.results) return null;

    const byId = new Map(model.tables.map((table) => [table.id, table]));

    return semantic.results
      .map((hit) => ({ table: byId.get(hit.id), score: hit.score }))
      .filter((entry): entry is { table: (typeof model.tables)[number]; score: number } =>
        Boolean(entry.table),
      );
  }, [mode, semantic.results, model.tables]);

  const visibleTables =
    semanticTables ?? filteredTables.map((table) => ({ table, score: undefined as number | undefined }));
  const hasQuery = search.trim().length > 0;

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <h2>Tablas</h2>
        <span>{model.tables.length}</span>
      </div>

      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={mode === 'semantic' ? 'Describe lo que buscas' : 'Buscar tabla o columna'}
        className="sidebar__search"
      />

      <div className="sidebar__modes" role="group" aria-label="Modo de búsqueda">
        <button type="button" className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>
          Texto
        </button>
        <button
          type="button"
          className={mode === 'semantic' ? 'active' : ''}
          onClick={() => setMode('semantic')}
        >
          Semántica
        </button>
      </div>

      {mode === 'semantic' && !semantic.externalAiAvailable ? (
        <div className="ai-control ai-control--offline">
          <span className="semantic-status__pill local">Modo sin conexión</span>
          <p className="ai-control__note">
            Esta compilación tiene la IA externa deshabilitada: el código de red no está
            incluido. La búsqueda semántica usa el motor local y funciona sin Internet.
          </p>
        </div>
      ) : mode === 'semantic' ? (
        <div className="ai-control">
          <label className="ai-control__switch">
            <input
              type="checkbox"
              checked={semantic.externalAllowed}
              onChange={(event) => semantic.setExternalAllowed(event.target.checked)}
            />
            <span>Permitir IA externa</span>
          </label>

          <p className="ai-control__note">
            Desactivada por defecto. El motor local funciona siempre sin Internet y sin enviar
            ningún dato. La IA externa solo descarga el modelo desde{' '}
            <code>{EXTERNAL_AI_HOST}</code> y se ejecuta en tu equipo: el esquema nunca se sube.
          </p>

          <div className="ai-control__status">
            {semantic.mode === 'neural' ? (
              <>
                <span className="semantic-status__pill neural">IA activa · en tu equipo</span>
                <button type="button" className="semantic-status__enable ghost" onClick={semantic.releaseNeural}>
                  Desactivar
                </button>
              </>
            ) : semantic.mode === 'loading' ? (
              <span className="semantic-status__pill loading">{semantic.progress || 'Cargando...'}</span>
            ) : semantic.mode === 'error' ? (
              <>
                <span className="semantic-status__pill error">
                  Bloqueado o sin Internet · se usa el motor local
                </span>
                <button type="button" className="semantic-status__enable" onClick={() => void semantic.loadNeural()}>
                  Reintentar
                </button>
              </>
            ) : (
              <>
                <span className="semantic-status__pill local">Motor local activo</span>
                <button
                  type="button"
                  className="semantic-status__enable"
                  disabled={!semantic.externalAllowed}
                  title={
                    semantic.externalAllowed
                      ? 'Descarga el modelo y ejecuta la búsqueda neuronal'
                      : 'Autoriza primero la IA externa'
                  }
                  onClick={() => void semantic.loadNeural()}
                >
                  Activar IA
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {mode === 'semantic' && hasQuery && visibleTables.length === 0 && semantic.mode !== 'loading' ? (
        <p className="sidebar__empty">Ninguna tabla encaja con esa descripción.</p>
      ) : null}

      <ul className="table-list">
        {visibleTables.map(({ table, score }) => (
          <li key={table.id}>
            <button
              type="button"
              className={selectedTableId === table.id ? 'table-list__item active' : 'table-list__item'}
              onClick={() => setSelectedTable(table.id)}
            >
              <span>{table.name}</span>
              {score === undefined ? (
                <small>{table.columns.length} cols</small>
              ) : (
                <small className="table-list__score">{Math.round(score * 100)}%</small>
              )}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

