import { useModelStore } from '../../state/modelStore';

export function TableTree() {
  const { model, selectedTableId, search, setSelectedTable, setSearch } = useModelStore();

  const filteredTables = model.tables.filter((table) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;

    const haystack = `${table.name} ${table.code} ${table.columns.map((column) => `${column.name} ${column.code}`).join(' ')}`.toLowerCase();
    return haystack.includes(query);
  });

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
        placeholder="Buscar tabla o columna"
        className="sidebar__search"
      />

      <ul className="table-list">
        {filteredTables.map((table) => (
          <li key={table.id}>
            <button
              type="button"
              className={selectedTableId === table.id ? 'table-list__item active' : 'table-list__item'}
              onClick={() => setSelectedTable(table.id)}
            >
              <span>{table.name}</span>
              <small>{table.columns.length} cols</small>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
