/**
 * Vista de relaciones: diagrama enfocado de la tabla seleccionada
 * con todas sus relaciones entrantes y salientes, índices y reglas.
 *
 * Se muestra en una pestaña propia para no saturar el diagrama principal.
 */

import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MiniMap, MarkerType } from 'reactflow';
import type { Edge, Node } from 'reactflow';
import { useModelStore } from '../../state/modelStore';
import type { Model, Table, Reference } from '../../model/types';

interface RelationInfo {
  reference: Reference;
  otherTable: Table;
  direction: 'parent' | 'child';
  joinLabels: string[];
  indexesCovering: string[];
}

function findCoveringIndexes(table: Table, columnIds: string[]): string[] {
  const covering: string[] = [];
  for (const index of table.indexes) {
    if (index.columns.some((col) => columnIds.includes(col))) {
      covering.push(index.name);
    }
  }
  for (const key of table.keys) {
    if (key.columns.some((col) => columnIds.includes(col))) {
      covering.push(key.name);
    }
  }
  return covering;
}

function collectRelations(model: Model, table: Table): RelationInfo[] {
  const results: RelationInfo[] = [];
  const tableById = new Map(model.tables.map((t) => [t.id, t]));

  for (const ref of model.references) {
    if (ref.parentTable === table.id) {
      const child = tableById.get(ref.childTable);
      if (!child) continue;
      const childColumnIds = ref.joins.map((j) => j.childColumn);
      results.push({
        reference: ref,
        otherTable: child,
        direction: 'child',
        joinLabels: ref.joins.map((j) => {
          const parentCol = table.columns.find((c) => c.id === j.parentColumn);
          const childCol = child.columns.find((c) => c.id === j.childColumn);
          return `${parentCol?.code ?? j.parentColumn} → ${childCol?.code ?? j.childColumn}`;
        }),
        indexesCovering: findCoveringIndexes(child, childColumnIds),
      });
    } else if (ref.childTable === table.id) {
      const parent = tableById.get(ref.parentTable);
      if (!parent) continue;
      const childColumnIds = ref.joins.map((j) => j.childColumn);
      results.push({
        reference: ref,
        otherTable: parent,
        direction: 'parent',
        joinLabels: ref.joins.map((j) => {
          const parentCol = parent.columns.find((c) => c.id === j.parentColumn);
          const childCol = table.columns.find((c) => c.id === j.childColumn);
          return `${parentCol?.code ?? j.parentColumn} → ${childCol?.code ?? j.childColumn}`;
        }),
        indexesCovering: findCoveringIndexes(table, childColumnIds),
      });
    }
  }

  return results;
}

/** Calcula posiciones radiales para las tablas alrededor de la central. */
function radialPositions(count: number, radiusX = 420, radiusY = 280): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  const startAngle = -Math.PI / 2;

  for (let i = 0; i < count; i += 1) {
    const angle = startAngle + (2 * Math.PI * i) / Math.max(count, 1);
    positions.push({
      x: Math.cos(angle) * radiusX,
      y: Math.sin(angle) * radiusY,
    });
  }
  return positions;
}

function TableNodeContent({ table, isCenter }: { table: Table; isCenter: boolean }) {
  const pk = table.primaryKey ?? table.keys.find((k) => k.isPrimary)?.columns ?? [];

  return (
    <div className={isCenter ? 'rel-node rel-node--center' : 'rel-node'}>
      <div className="rel-node__header">
        <span className="rel-node__title">{table.name}</span>
        <span className="rel-node__count">{table.columns.length} col</span>
      </div>
      <div className="rel-node__body">
        {table.columns.slice(0, isCenter ? 10 : 5).map((column) => {
          const isPk = pk.includes(column.id);
          return (
            <div key={column.id} className="rel-node__row">
              <span className={`rel-node__flag ${isPk ? 'pk' : 'col'}`}>{isPk ? 'PK' : '·'}</span>
              <span className="rel-node__name">{column.code}</span>
              <span className="rel-node__type">{column.dataType}</span>
            </div>
          );
        })}
        {!isCenter && table.columns.length > 5 ? (
          <div className="rel-node__more">+{table.columns.length - 5} más</div>
        ) : null}
        {isCenter && table.columns.length > 10 ? (
          <div className="rel-node__more">+{table.columns.length - 10} más</div>
        ) : null}
      </div>
      {table.indexes.length > 0 && (
        <div className="rel-node__indexes">
          {table.indexes.slice(0, 3).map((index) => (
            <span key={index.id} className="rel-node__idx" title={index.columns.join(', ')}>
              {index.unique ? 'UQ' : 'IX'} {index.name}
            </span>
          ))}
          {table.indexes.length > 3 ? (
            <span className="rel-node__idx">+{table.indexes.length - 3}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function RelationsView() {
  const model = useModelStore((state) => state.model);
  const selectedTableId = useModelStore((state) => state.selectedTableId);

  const selectedTable = model.tables.find((t) => t.id === selectedTableId) ?? model.tables[0];

  const relations = useMemo(
    () => (selectedTable ? collectRelations(model, selectedTable) : []),
    [model, selectedTable],
  );

  const { nodes, edges } = useMemo(() => {
    if (!selectedTable) return { nodes: [], edges: [] };

    const positions = radialPositions(relations.length);
    const nodeList: Node[] = [];
    const edgeList: Edge[] = [];

    // Nodo central
    nodeList.push({
      id: selectedTable.id,
      position: { x: 0, y: 0 },
      data: { label: <TableNodeContent table={selectedTable} isCenter /> },
      style: { width: 280, background: 'transparent', border: 'none', padding: 0 },
      draggable: true,
    });

    relations.forEach((rel, i) => {
      const pos = positions[i] ?? { x: 0, y: 0 };

      nodeList.push({
        id: `${rel.reference.id}-node`,
        position: { x: pos.x - 110, y: pos.y - 70 },
        data: { label: <TableNodeContent table={rel.otherTable} isCenter={false} /> },
        style: { width: 220, background: 'transparent', border: 'none', padding: 0 },
        draggable: true,
      });

      const isParentSide = rel.direction === 'parent';
      const hasIndex = rel.indexesCovering.length > 0;

      edgeList.push({
        id: rel.reference.id,
        source: isParentSide ? `${rel.reference.id}-node` : selectedTable.id,
        target: isParentSide ? selectedTable.id : `${rel.reference.id}-node`,
        label: rel.reference.cardinality,
        type: 'smoothstep',
        animated: rel.reference.onDelete === 'CASCADE',
        markerEnd: { type: MarkerType.ArrowClosed },
        labelBgStyle: { fill: '#0f172a', fillOpacity: 0.85 },
        labelStyle: { fill: '#e2e8f0', fontSize: 11, fontWeight: 700 },
        style: {
          stroke: hasIndex ? '#22c55e' : '#f59e0b',
          strokeWidth: hasIndex ? 2.5 : 2,
          strokeDasharray: hasIndex ? undefined : '6 3',
        },
      });
    });

    return { nodes: nodeList, edges: edgeList };
  }, [selectedTable, relations]);

  if (!selectedTable) {
    return <section className="rel-view__empty">Selecciona una tabla para ver sus relaciones.</section>;
  }

  const incoming = relations.filter((r) => r.direction === 'parent');
  const outgoing = relations.filter((r) => r.direction === 'child');

  return (
    <section className="rel-view">
      <header className="rel-view__header">
        <div>
          <p className="eyebrow">Relaciones</p>
          <h2>{selectedTable.name}</h2>
          <p className="rel-view__meta">
            {incoming.length} entrantes · {outgoing.length} salientes ·{' '}
            {selectedTable.indexes.length} índices
          </p>
        </div>

        <div className="rel-view__legend">
          <span className="rel-view__legend-item">
            <span className="rel-view__swatch indexed" />
            Con índice
          </span>
          <span className="rel-view__legend-item">
            <span className="rel-view__swatch no-index" />
            Sin índice
          </span>
          <span className="rel-view__legend-item">
            <span className="rel-view__swatch cascade" />
            ON DELETE CASCADE
          </span>
        </div>
      </header>

      <div className="rel-view__diagram">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={1.8}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          defaultEdgeOptions={{ type: 'smoothstep' }}
        >
          <Background color="#334155" gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeStrokeColor="#475569"
            nodeColor="#1e293b"
            maskColor="rgba(2, 6, 23, 0.75)"
          />
        </ReactFlow>
      </div>

      <div className="rel-view__details">
        <div className="rel-view__detail-card">
          <h3>Relaciones entrantes</h3>
          {incoming.length === 0 ? (
            <p className="rel-view__none">Ninguna tabla apunta a esta tabla.</p>
          ) : (
            <ul>
              {incoming.map((rel) => (
                <li key={rel.reference.id} className={rel.indexesCovering.length > 0 ? 'has-index' : 'no-index'}>
                  <div className="rel-view__rel-top">
                    <strong>{rel.otherTable.name}</strong>
                    <span className="rel-view__cardinality">{rel.reference.cardinality}</span>
                    {rel.indexesCovering.length > 0 ? (
                      <span className="rel-view__badge ok">IDX</span>
                    ) : (
                      <span className="rel-view__badge warn">SIN IDX</span>
                    )}
                  </div>
                  <div className="rel-view__joins">
                    {rel.joinLabels.map((label) => (
                      <code key={label}>{label}</code>
                    ))}
                  </div>
                  <div className="rel-view__rules">
                    {rel.reference.onDelete && <span>ON DELETE {rel.reference.onDelete}</span>}
                    {rel.reference.onUpdate && <span>ON UPDATE {rel.reference.onUpdate}</span>}
                    {rel.indexesCovering.map((name) => (
                      <span key={name} className="rel-view__idx-name">IX {name}</span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rel-view__detail-card">
          <h3>Relaciones salientes</h3>
          {outgoing.length === 0 ? (
            <p className="rel-view__none">Esta tabla no apunta a ninguna otra.</p>
          ) : (
            <ul>
              {outgoing.map((rel) => (
                <li key={rel.reference.id} className={rel.indexesCovering.length > 0 ? 'has-index' : 'no-index'}>
                  <div className="rel-view__rel-top">
                    <strong>{rel.otherTable.name}</strong>
                    <span className="rel-view__cardinality">{rel.reference.cardinality}</span>
                    {rel.indexesCovering.length > 0 ? (
                      <span className="rel-view__badge ok">IDX</span>
                    ) : (
                      <span className="rel-view__badge warn">SIN IDX</span>
                    )}
                  </div>
                  <div className="rel-view__joins">
                    {rel.joinLabels.map((label) => (
                      <code key={label}>{label}</code>
                    ))}
                  </div>
                  <div className="rel-view__rules">
                    {rel.reference.onDelete && <span>ON DELETE {rel.reference.onDelete}</span>}
                    {rel.reference.onUpdate && <span>ON UPDATE {rel.reference.onUpdate}</span>}
                    {rel.indexesCovering.map((name) => (
                      <span key={name} className="rel-view__idx-name">IX {name}</span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rel-view__detail-card">
          <h3>Índices de consulta</h3>
          {selectedTable.indexes.length === 0 ? (
            <p className="rel-view__none">Sin índices definidos.</p>
          ) : (
            <ul>
              {selectedTable.indexes.map((index) => {
                const colNames = index.columns
                  .map((colId) => selectedTable.columns.find((c) => c.id === colId)?.code ?? colId);
                return (
                  <li key={index.id}>
                    <div className="rel-view__rel-top">
                      <strong>{index.name}</strong>
                      <span className={`rel-view__badge ${index.unique ? 'ok' : 'info'}`}>
                        {index.unique ? 'UNIQUE' : 'INDEX'}
                      </span>
                    </div>
                    <div className="rel-view__joins">
                      {colNames.map((name) => (
                        <code key={name}>{name}</code>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
