import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useReactFlow,
} from 'reactflow';
import type { Edge, Node } from 'reactflow';
import { useMemo, useEffect, useCallback } from 'react';
import { useModelStore } from '../../state/modelStore';
import type { LayerView } from '../../state/modelStore';
import type { Model, Table } from '../../model/types';
import {
  computeSemanticFlags,
  neighborsWithinHops,
  shortestPath,
  pathEdgeIds,
  findFkCycles,
  heatValues,
  heatClass,
} from '../../utils/graphUtils';
import type { HeatMetric } from '../../utils/graphUtils';
import { lintModel } from '../../utils/modelLinter';
import { useAnnotationStore } from '../../state/annotationStore';

const LAYERS: { id: LayerView; label: string }[] = [
  { id: 'all', label: 'Todo' },
  { id: 'tables', label: 'Tablas' },
  { id: 'fk', label: 'FKs' },
  { id: 'indexes', label: 'Índices' },
  { id: 'domains', label: 'Dominios' },
  { id: 'comments', label: 'Comentarios' },
  { id: 'audit', label: 'Auditoría' },
];

const HEAT_METRICS: { id: HeatMetric; label: string }[] = [
  { id: 'columns', label: 'Columnas' },
  { id: 'relations', label: 'Relaciones' },
  { id: 'indexes', label: 'Índices' },
  { id: 'issues', label: 'Incidencias' },
];

const AUDIT_COLUMNS = ['created_at', 'updated_at', 'created_by', 'updated_by', 'created_date', 'modified_date'];

function isAuditColumn(code: string): boolean {
  return AUDIT_COLUMNS.some((name) => code.toLowerCase().includes(name));
}

/** Filtra las columnas visibles según la capa activa y el modo ocultar no-clave. */
function visibleColumns(
  table: Table,
  model: Model,
  layer: LayerView,
  hideNonKey: boolean,
): typeof table.columns {
  let columns = table.columns;

  if (hideNonKey) {
    const pk = new Set(table.primaryKey ?? table.keys.find((k) => k.isPrimary)?.columns ?? []);
    const fkCols = new Set<string>();
    for (const ref of model.references) {
      if (ref.childTable === table.id) {
        for (const join of ref.joins) fkCols.add(join.childColumn);
      }
    }
    columns = columns.filter((c) => pk.has(c.id) || fkCols.has(c.id));
  }

  switch (layer) {
    case 'comments':
      return columns.filter((c) => c.comment);
    case 'audit':
      return columns.filter((c) => isAuditColumn(c.code));
    default:
      return columns;
  }
}

/** Indica si una tabla debe mostrarse según la capa. */
function tableVisible(table: Table, layer: LayerView): boolean {
  if (layer === 'domains') return table.columns.some((c) => c.dataType.toLowerCase().includes('domain'));
  return true;
}

interface NodeData extends Record<string, unknown> {
  label: React.ReactNode;
}

export function ERDiagram() {
  const {
    model,
    selectedTableId,
    layer,
    collapsed,
    hideNonKey,
    focusHops,
    heatMetric,
    pathFrom,
    pathTo,
    setPathPoint,
    toggleCollapse,
    setSelectedTable,
  } = useModelStore();

  const annotations = useAnnotationStore((state) => state.annotations);
  const annotationCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const ann of annotations) {
      map.set(ann.tableId, (map.get(ann.tableId) ?? 0) + 1);
    }
    return map;
  }, [annotations]);

  const flags = useMemo(() => computeSemanticFlags(model), [model]);
  const cycles = useMemo(() => findFkCycles(model), [model]);
  const cycleTables = useMemo(() => {
    const set = new Set<string>();
    for (const cycle of cycles) for (const id of cycle) set.add(id);
    return set;
  }, [cycles]);

  const report = useMemo(() => lintModel(model), [model]);
  const issuesByTable = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of report.issues) {
      if (issue.tableId) map.set(issue.tableId, (map.get(issue.tableId) ?? 0) + 1);
    }
    return map;
  }, [report.issues]);

  const heat = useMemo(
    () => (heatMetric ? heatValues(model, heatMetric, issuesByTable) : null),
    [model, heatMetric, issuesByTable],
  );
  const heatRange = useMemo(() => {
    if (!heat || heat.size === 0) return { min: 0, max: 1 };
    const values = [...heat.values()];
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [heat]);

  // Modo foco: tablas visibles = origen + vecinas en N saltos.
  const focusSet = useMemo(() => {
    if (focusHops === null || !selectedTableId) return null;
    const neighbors = neighborsWithinHops(model, selectedTableId, focusHops);
    neighbors.add(selectedTableId);
    return neighbors;
  }, [model, selectedTableId, focusHops]);

  // Camino mínimo entre pathFrom y pathTo.
  const pathIds = useMemo(() => {
    if (!pathFrom || !pathTo) return null;
    return shortestPath(model, pathFrom, pathTo);
  }, [model, pathFrom, pathTo]);

  const highlightedEdges = useMemo(() => {
    if (!pathIds) return null;
    return pathEdgeIds(model, pathIds);
  }, [model, pathIds]);

  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      if (pathFrom && !pathTo && node.id !== pathFrom) {
        setPathPoint('to', node.id);
      } else {
        setSelectedTable(node.id);
      }
    },
    [pathFrom, pathTo, setPathPoint, setSelectedTable],
  );

  const nodes: Node[] = useMemo(() => {
    const result: Node[] = [];

    model.tables.forEach((table, index) => {
      if (!tableVisible(table, layer)) return;
      if (focusSet && !focusSet.has(table.id)) return;

      const fallbackPosition = {
        x: (index % 3) * 340,
        y: Math.floor(index / 3) * 260,
      };
      const position = table.position ?? fallbackPosition;
      const isSelected = selectedTableId === table.id;
      const isCollapsed = collapsed.has(table.id);

      const isPathStart = pathFrom === table.id;
      const isPathEnd = pathTo === table.id;
      const onPath = pathIds?.includes(table.id) ?? false;

      const tableFlags: string[] = [];
      if (flags.noPk.has(table.id)) tableFlags.push('sin PK');
      if (flags.orphan.has(table.id)) tableFlags.push('huérfana');
      if (flags.god.has(table.id)) tableFlags.push('god');
      if (flags.fkNoIndex.has(table.id)) tableFlags.push('FK s/índice');
      if (flags.nullableKey.has(table.id)) tableFlags.push('PK nullable');
      if (cycleTables.has(table.id)) tableFlags.push('ciclo');

      const cols = isCollapsed ? [] : visibleColumns(table, model, layer, hideNonKey);
      const heatIdx = heat ? heatClass(heat.get(table.id) ?? 0, heatRange.min, heatRange.max) : null;

      result.push({
        id: table.id,
        position,
        data: {
          label: (
            <div
              className={[
                'er-node',
                isSelected ? 'er-node--selected' : '',
                isPathStart ? 'er-node--path-start' : '',
                isPathEnd ? 'er-node--path-end' : '',
                onPath && !isPathStart && !isPathEnd ? 'er-node--path' : '',
                heatIdx !== null ? `er-node--heat-${heatIdx}` : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                className="er-node__header"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleCollapse(table.id);
                }}
                title={isCollapsed ? 'Expandir' : 'Colapsar'}
              >
                <span className="er-node__collapse">{isCollapsed ? '▸' : '▾'}</span>
                <span className="er-node__title">{table.name}</span>
                {(annotationCounts.get(table.id) ?? 0) > 0 && (
                  <span
                    className="er-node__ann"
                    title={`${annotationCounts.get(table.id)} anotación(es)`}
                  >
                    ✎ {annotationCounts.get(table.id)}
                  </span>
                )}
                <span className="er-node__count">{table.columns.length}</span>
              </button>

              {tableFlags.length > 0 && (
                <div className="er-node__flags">
                  {tableFlags.map((flag) => (
                    <span key={flag} className="er-node__warn" title={flag}>
                      {flag}
                    </span>
                  ))}
                </div>
              )}

              {!isCollapsed && (
                <div className="er-node__body">
                  {cols.slice(0, 8).map((column) => {
                    const pkSet = new Set(table.primaryKey ?? table.keys.find((k) => k.isPrimary)?.columns ?? []);
                    const isPk = pkSet.has(column.id);
                    const isFk = model.references.some(
                      (reference) =>
                        reference.childTable === table.id &&
                        reference.joins.some((join) => join.childColumn === column.id),
                    );

                    return (
                      <div key={column.id} className="er-node__row">
                        <span className="er-node__meta">
                          {isPk ? <span className="er-node__flag pk">PK</span> : null}
                          {isFk ? <span className="er-node__flag fk">FK</span> : null}
                        </span>
                        <span className="er-node__name">{column.name}</span>
                        <span className="er-node__type">{column.dataType}</span>
                        <span
                          className={
                            column.mandatory
                              ? 'er-node__nullability not-null'
                              : 'er-node__nullability nullable'
                          }
                        >
                          {column.mandatory ? 'NN' : 'NULL'}
                        </span>
                      </div>
                    );
                  })}
                  {isCollapsed && table.columns.length > 0 ? null : cols.length === 0 && table.columns.length > 0 ? (
                    <div className="er-node__more">0 visibles / {table.columns.length}</div>
                  ) : cols.length > 8 ? (
                    <div className="er-node__more">+{cols.length - 8} más</div>
                  ) : null}
                </div>
              )}

              {isCollapsed && (
                <div className="er-node__more">{table.columns.length} columnas</div>
              )}
            </div>
          ) as NodeData['label'],
        },
        className: isSelected ? 'selected-node' : '',
        style: {
          width: table.position?.w ?? 240,
          minWidth: 200,
          background: 'transparent',
          border: 'none',
          padding: 0,
        },
        selected: isSelected,
      });
    });

    return result;
  }, [
    model,
    layer,
    collapsed,
    hideNonKey,
    focusSet,
    selectedTableId,
    flags,
    cycleTables,
    heat,
    heatRange,
    pathFrom,
    pathTo,
    pathIds,
    annotationCounts,
    toggleCollapse,
  ]);

  const edges: Edge[] = useMemo(() => {
    return model.references.map((reference) => {
      const visible = !focusSet || (focusSet.has(reference.parentTable) && focusSet.has(reference.childTable));

      const onPath = highlightedEdges?.has(reference.id) ?? false;
      const inCycle =
        cycleTables.has(reference.parentTable) && cycleTables.has(reference.childTable);

      let className = '';
      if (onPath) className = 'edge--path';
      else if (inCycle) className = 'edge--cycle';
      else if (layer === 'fk') className = 'edge--emphasis';

      return {
        id: reference.id,
        source: reference.parentTable,
        target: reference.childTable,
        label: reference.cardinality,
        animated: onPath,
        visible,
        type: 'smoothstep',
        className,
        markerEnd: { type: MarkerType.ArrowClosed },
        style:
          onPath
            ? { stroke: '#f59e0b', strokeWidth: 3 }
            : inCycle
              ? { stroke: '#ef4444', strokeWidth: 2.5, strokeDasharray: '6 3' }
              : layer === 'indexes'
                ? { stroke: '#a78bfa', strokeWidth: 2 }
                : undefined,
      };
    });
  }, [model, focusSet, layer, highlightedEdges, cycleTables]);

  return (
    <div className="diagram-panel">
      <div className="diagram-toolbar">
        <div className="diagram-toolbar__group" role="group" aria-label="Capas">
          <span className="diagram-toolbar__label">Capa</span>
          {LAYERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={layer === item.id ? 'active' : ''}
              onClick={() => useModelStore.getState().setLayer(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="diagram-toolbar__group" role="group" aria-label="Opciones">
          <button
            type="button"
            className={hideNonKey ? 'active' : ''}
            onClick={() => useModelStore.getState().setHideNonKey(!hideNonKey)}
            title="Mostrar solo columnas PK y FK"
          >
            Solo claves
          </button>

          {[1, 2, 3].map((hops) => (
            <button
              key={hops}
              type="button"
              className={focusHops === hops ? 'active' : ''}
              onClick={() => useModelStore.getState().setFocusHops(focusHops === hops ? null : hops)}
              title={`Ver tablas a ${hops} salto${hops > 1 ? 's' : ''}`}
            >
              {hops} salto{hops > 1 ? 's' : ''}
            </button>
          ))}
          {focusHops !== null && (
            <button type="button" onClick={() => useModelStore.getState().setFocusHops(null)}>
              ✕ Foco
            </button>
          )}
        </div>

        <div className="diagram-toolbar__group" role="group" aria-label="Mapa de calor">
          <span className="diagram-toolbar__label">Mapa</span>
          {HEAT_METRICS.map((metric) => (
            <button
              key={metric.id}
              type="button"
              className={heatMetric === metric.id ? 'active' : ''}
              onClick={() =>
                useModelStore.getState().setHeatMetric(heatMetric === metric.id ? null : metric.id)
              }
            >
              {metric.label}
            </button>
          ))}
        </div>

        <div className="diagram-toolbar__group" role="group" aria-label="Ruta">
          <span className="diagram-toolbar__label">Ruta</span>
          <button
            type="button"
            className={pathFrom ? 'active' : ''}
            onClick={() => useModelStore.getState().setPathPoint('from', pathFrom ? null : selectedTableId)}
            title="Seleccionar tabla de origen"
          >
            {pathFrom ? 'Origen ✓' : 'Origen'}
          </button>
          <button
            type="button"
            className={pathTo ? 'active' : ''}
            disabled={!pathFrom}
            onClick={() => useModelStore.getState().setPathPoint('to', pathTo ? null : selectedTableId)}
            title="Seleccionar tabla destino"
          >
            {pathTo ? 'Destino ✓' : 'Destino'}
          </button>
          {(pathFrom || pathTo) && (
            <button type="button" onClick={() => useModelStore.getState().clearPath()}>
              ✕
            </button>
          )}
        </div>
      </div>

      {pathFrom && pathTo && (
        <div className="diagram-path-banner">
          {pathIds
            ? `Ruta: ${pathIds
                .map((id) => model.tables.find((t) => t.id === id)?.name ?? id)
                .join(' → ')}  (${pathIds.length - 1} salto${pathIds.length > 2 ? 's' : ''})`
            : 'No existe ruta entre esas tablas'}
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        defaultEdgeOptions={{ type: 'smoothstep' }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={onNodeClick}
        minZoom={0.1}
        maxZoom={2}
      >
        <FitViewOnPath pathFrom={pathFrom} pathTo={pathTo} />
        <Background color="#cbd5e1" gap={18} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeStrokeColor="#334155"
          nodeColor={(node) => {
            if (node.id === selectedTableId) return '#2563eb';
            if (pathIds?.includes(node.id)) return '#f59e0b';
            if (focusSet && !focusSet.has(node.id)) return '#e2e8f0';
            return '#94a3b8';
          }}
          maskColor="rgba(15, 23, 42, 0.7)"
        />
      </ReactFlow>
    </div>
  );
}

/** Ajusta la vista cuando se completa la selección de ruta. Debe vivir dentro de <ReactFlow>. */
function FitViewOnPath({ pathFrom, pathTo }: { pathFrom: string | null; pathTo: string | null }) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (pathFrom && pathTo) {
      const timer = window.setTimeout(() => {
        void fitView({ padding: 0.3, duration: 400 });
      }, 50);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [pathFrom, pathTo, fitView]);

  return null;
}
