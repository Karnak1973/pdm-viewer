import ReactFlow, { Background, Controls, MarkerType } from 'reactflow';
import type { Edge, Node } from 'reactflow';
import { useModelStore } from '../../state/modelStore';

export function ERDiagram() {
  const { model, selectedTableId } = useModelStore();

  const nodes: Node[] = model.tables.map((table, index) => {
    const fallbackPosition = {
      x: (index % 3) * 340,
      y: Math.floor(index / 3) * 260,
    };

    const position = table.position ?? fallbackPosition;
    const isSelected = selectedTableId === table.id;

    return {
      id: table.id,
      position,
      data: {
        label: (
          <div className={isSelected ? 'er-node er-node--selected' : 'er-node'}>
            <div className="er-node__header">
              <span className="er-node__title">{table.name}</span>
              <span className="er-node__count">{table.columns.length}</span>
            </div>

            <div className="er-node__body">
              {table.columns.slice(0, 6).map((column) => {
                const isPk = table.primaryKey?.includes(column.id) ?? false;
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
                    <span className={column.mandatory ? 'er-node__nullability not-null' : 'er-node__nullability nullable'}>
                      {column.mandatory ? 'NN' : 'NULL'}
                    </span>
                  </div>
                );
              })}
              {table.columns.length > 6 ? (
                <div className="er-node__more">+{table.columns.length - 6} más</div>
              ) : null}
            </div>
          </div>
        ),
      },
      className: isSelected ? 'selected-node' : '',
      style: {
        width: table.position?.w ?? 240,
        minWidth: 220,
        background: 'transparent',
        border: 'none',
        padding: 0,
      },
      selected: isSelected,
    };
  });

  const edges: Edge[] = model.references.map((reference) => ({
    id: reference.id,
    source: reference.parentTable,
    target: reference.childTable,
    label: reference.cardinality,
    animated: false,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
  }));

  return (
    <div className="diagram-panel">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        defaultEdgeOptions={{ type: 'smoothstep' }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#cbd5e1" gap={18} size={1} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
