/**
 * Command palette de búsqueda global (Ctrl+K / Cmd+K).
 *
 * Busca en tablas, columnas, comentarios, claves, índices y dominios.
 * Al seleccionar un resultado navega a la tabla y cierra el panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useModelStore } from '../../state/modelStore';
import { globalSearch, groupHits, availablePrefixes } from '../../utils/globalSearch';
import type { SearchHit, SearchKind, SearchFilters } from '../../utils/globalSearch';

const KIND_LABEL: Record<SearchKind, string> = {
  table: 'Tablas',
  column: 'Columnas',
  comment: 'Comentarios',
  key: 'Claves',
  index: 'Índices',
  domain: 'Dominios',
};

const ALL_KINDS: SearchKind[] = ['table', 'column', 'comment', 'key', 'index', 'domain'];

function HitItem({
  hit,
  active,
  onSelect,
}: {
  hit: SearchHit;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={active ? 'gs-result active' : 'gs-result'}
        onClick={onSelect}
        data-kind={hit.kind}
      >
        <span className={`gs-result__kind ${hit.kind}`}>{KIND_LABEL[hit.kind]}</span>
        <span className="gs-result__title">{hit.title}</span>
        <span className="gs-result__subtitle">{hit.subtitle}</span>
      </button>
    </li>
  );
}

export function GlobalSearch() {
  const model = useModelStore((state) => state.model);
  const setSelectedTable = useModelStore((state) => state.setSelectedTable);
  const setView = useModelStore((state) => state.setView);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [kindFilter, setKindFilter] = useState<Set<SearchKind>>(new Set());
  const [prefixFilter, setPrefixFilter] = useState('');

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const prefixes = useMemo(() => availablePrefixes(model), [model]);

  const filters: SearchFilters = useMemo(
    () => ({
      kinds: kindFilter.size > 0 ? kindFilter : null,
      prefix: prefixFilter || null,
    }),
    [kindFilter, prefixFilter],
  );

  const hits = useMemo(() => globalSearch(model, query, filters), [model, query, filters]);
  const grouped = useMemo(() => groupHits(hits), [hits]);

  // Flat list for keyboard navigation (ordered by group).
  const flatHits = useMemo(() => {
    const result: SearchHit[] = [];
    for (const kind of ALL_KINDS) {
      const list = grouped.get(kind);
      if (list) result.push(...list);
    }
    return result;
  }, [grouped]);

  // Abrir/cerrar con Ctrl+K / Cmd+K y Escape.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Enfocar input al abrir.
  useEffect(() => {
    if (open) {
      setCursor(0);
      inputRef.current?.focus();
    } else {
      setQuery('');
      setKindFilter(new Set());
      setPrefixFilter('');
    }
  }, [open]);

  // Reset cursor cuando cambian los resultados.
  useEffect(() => {
    setCursor(0);
  }, [hits.length]);

  const selectHit = useCallback(
    (hit: SearchHit) => {
      const tableId = hit.tableId ?? hit.id;
      // Solo navegar si es una tabla o algo con tabla padre.
      const targetTable = model.tables.find((t) => t.id === tableId);
      if (targetTable) {
        setSelectedTable(targetTable.id);
        setView('diagram');
      }
      setOpen(false);
    },
    [model.tables, setSelectedTable, setView],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, flatHits.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = flatHits[cursor];
      if (hit) selectHit(hit);
    }
  };

  const toggleKind = (kind: SearchKind) => {
    setKindFilter((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  // Scroll activo a la vista.
  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector('.gs-result.active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <>
      <button
        type="button"
        className="gs-trigger"
        onClick={() => setOpen(true)}
        title="Buscar globalmente (Ctrl+K)"
      >
        🔍 Buscar
        <kbd>Ctrl</kbd>
        <kbd>K</kbd>
      </button>

      {open && (
        <div className="gs-overlay" onClick={() => setOpen(false)}>
          <div className="gs-panel" onClick={(event) => event.stopPropagation()}>
            <div className="gs-search">
              <span className="gs-search__icon">🔍</span>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Buscar tablas, columnas, comentarios, claves…"
                aria-label="Búsqueda global"
              />
              <button type="button" className="gs-search__close" onClick={() => setOpen(false)}>
                ESC
              </button>
            </div>

            <div className="gs-filters">
              <div className="gs-filters__kinds">
                {ALL_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={kindFilter.has(kind) ? 'active' : ''}
                    onClick={() => toggleKind(kind)}
                  >
                    {KIND_LABEL[kind]}
                  </button>
                ))}
              </div>

              {prefixes.length > 0 && (
                <select
                  className="gs-filters__prefix"
                  value={prefixFilter}
                  onChange={(event) => setPrefixFilter(event.target.value)}
                  aria-label="Filtrar por prefijo"
                >
                  <option value="">Todos los módulos</option>
                  {prefixes.map((prefix) => (
                    <option key={prefix} value={prefix}>
                      {prefix}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="gs-results" ref={listRef}>
              {query.trim() === '' ? (
                <p className="gs-results__hint">
                  Escribe para buscar en {model.tables.length} tablas,{' '}
                  {model.tables.reduce((sum, t) => sum + t.columns.length, 0)} columnas y{' '}
                  {model.domains.length} dominios.
                </p>
              ) : flatHits.length === 0 ? (
                <p className="gs-results__hint">Sin resultados para «{query}».</p>
              ) : (
                <ul>
                  {flatHits.map((hit, index) => (
                    <HitItem
                      key={`${hit.kind}-${hit.id}-${index}`}
                      hit={hit}
                      active={index === cursor}
                      onSelect={() => selectHit(hit)}
                    />
                  ))}
                </ul>
              )}
            </div>

            <div className="gs-footer">
              <span>
                <kbd>↑↓</kbd> navegar
              </span>
              <span>
                <kbd>↵</kbd> abrir
              </span>
              <span>
                <kbd>Esc</kbd> cerrar
              </span>
              <span className="gs-footer__count">{flatHits.length} resultados</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
