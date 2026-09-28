/**
 * Panel de comparación entre dos modelos PDM.
 *
 * Muestra los cambios agrupados por tipo de objeto con semántica de color:
 * verde = añadido, rojo = eliminado, ámbar = modificado.
 */

import { useEffect, useRef, useState } from 'react';
import type { Model } from '../../model/types';
import { useDiffStore } from '../../state/diffStore';
import { parsePowerDesignerXml } from '../../parser/xmlParser';
import { normalizeModel } from '../../parser/normalizer';
import type { ObjectDiff, ChangeKind } from '../../utils/modelDiff';
import { MigrationSection } from './MigrationSection';

const KIND_LABEL: Record<ChangeKind, string> = {
  added: 'Añadida',
  removed: 'Eliminada',
  modified: 'Modificada',
};

function DiffGroup({ title, items }: { title: string; items: ObjectDiff[] }) {
  if (items.length === 0) return null;

  return (
    <div className="diff-group">
      <h4>
        {title}
        <span className="diff-group__count">{items.length}</span>
      </h4>
      <ul>
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className={`diff-item ${item.kind}`}>
            <div className="diff-item__top">
              <span className={`diff-item__kind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
              <strong>
                {item.parent ? `${item.parent}.` : ''}
                {item.name}
              </strong>
            </div>
            {item.changes.length > 0 && (
              <table className="diff-item__changes">
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>Antes</th>
                    <th>Después</th>
                  </tr>
                </thead>
                <tbody>
                  {item.changes.map((change) => (
                    <tr key={change.field}>
                      <td>{change.field}</td>
                      <td className="before">{change.before}</td>
                      <td className="after">{change.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DiffPanel({ model }: { model: Model }) {
  const targetModel = useDiffStore((state) => state.targetModel);
  const targetName = useDiffStore((state) => state.targetName);
  const diff = useDiffStore((state) => state.diff);
  const setTarget = useDiffStore((state) => state.setTarget);
  const clearTarget = useDiffStore((state) => state.clearTarget);
  const recompute = useDiffStore((state) => state.recompute);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState('');

  // Recalcular cuando cambia cualquiera de los dos modelos.
  useEffect(() => {
    if (targetModel) recompute(model);
  }, [model, targetModel, recompute]);

  const loadTarget = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parsePowerDesignerXml(text);
      const target = normalizeModel(parsed, file.name.replace(/\.[^.]+$/, ''));
      setTarget(target, file.name);
      setStatus(`Comparando contra: ${file.name} (${target.tables.length} tablas)`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'No se pudo leer el fichero.');
    }
  };

  if (!targetModel) {
    return (
      <section className="diff-panel">
        <div className="diff-panel__empty">
          <h3>Comparar dos modelos</h3>
          <p>
            Carga un segundo fichero <code>.pdm</code> para ver las diferencias frente al modelo
            actual: tablas, columnas, tipos, relaciones e índices añadidos, eliminados o
            modificados.
          </p>
          <button type="button" onClick={() => inputRef.current?.click()}>
            Cargar fichero .pdm de comparación
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".pdm,.xml"
            hidden
            onChange={(event) => {
              void loadTarget(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="diff-panel">
      <header className="diff-panel__header">
        <div>
          <p className="eyebrow">Comparación</p>
          <h3>
            {model.name} <span className="diff-panel__vs">vs</span> {targetName}
          </h3>
          {status && <p className="diff-panel__status">{status}</p>}
        </div>
        <div className="diff-panel__actions">
          <button type="button" onClick={() => inputRef.current?.click()}>
            Cambiar fichero
          </button>
          <button
            type="button"
            onClick={() => {
              clearTarget();
              setStatus('');
            }}
          >
            Limpiar
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdm,.xml"
          hidden
          onChange={(event) => {
            void loadTarget(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </header>

      {diff && (
        <>
          <div className="diff-summary">
            <span className="diff-summary__item added">
              <strong>{diff.summary.added}</strong> añadidos
            </span>
            <span className="diff-summary__item removed">
              <strong>{diff.summary.removed}</strong> eliminados
            </span>
            <span className="diff-summary__item modified">
              <strong>{diff.summary.modified}</strong> modificados
            </span>
            <span className="diff-summary__item total">
              <strong>{diff.summary.total}</strong> cambios totales
            </span>
          </div>

          {diff.summary.total === 0 ? (
            <p className="diff-panel__none">Los dos modelos son idénticos.</p>
          ) : (
            <>
              <div className="diff-body">
                <DiffGroup title="Tablas" items={diff.tables} />
                <DiffGroup title="Columnas" items={diff.columns} />
                <DiffGroup title="Relaciones" items={diff.references} />
                <DiffGroup title="Índices" items={diff.indexes} />
                <DiffGroup title="Claves" items={diff.keys} />
              </div>

              <MigrationSection model={model} targetModel={targetModel} />
            </>
          )}
        </>
      )}
    </section>
  );
}
