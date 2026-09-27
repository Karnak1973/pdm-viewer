import { useState } from 'react';
import type { Table } from '../../model/types';
import { normalizeModel } from '../../parser/normalizer';
import { parsePowerDesignerXml } from '../../parser/xmlParser';
import { applyPdmEdits } from '../../parser/xmlPatch';
import { useModelStore } from '../../state/modelStore';
import { downloadFile } from '../../utils/reportExport';
import {
  buildTableEdits,
  isTableDraftValid,
  toTableDraft,
  type TableDraft,
} from '../../utils/pdmEdits';

interface Props {
  table: Table;
  onClose: () => void;
}

export function TableEditor({ table, onClose }: Props) {
  const model = useModelStore((state) => state.model);
  const sourceXml = useModelStore((state) => state.sourceXml);
  const sourceFileName = useModelStore((state) => state.sourceFileName);
  const setModel = useModelStore((state) => state.setModel);

  const [draft, setDraft] = useState<TableDraft>(() => toTableDraft(table));

  const editable = Boolean(sourceXml && table.pdId);
  const valid = isTableDraftValid(draft);
  const edits = editable ? buildTableEdits(table, draft) : [];
  const dirty = edits.length > 0;

  const updateColumn = (index: number, patch: Partial<TableDraft['columns'][number]>) => {
    setDraft((current) => ({
      ...current,
      columns: current.columns.map((column, i) => (i === index ? { ...column, ...patch } : column)),
    }));
  };

  const handleSave = () => {
    if (!sourceXml || !valid || edits.length === 0) return;

    const patched = applyPdmEdits(sourceXml, edits);
    const nextModel = normalizeModel(parsePowerDesignerXml(patched), model.name);

    setModel(nextModel, {
      xml: patched,
      fileName: sourceFileName ?? `${model.name}.pdm`,
      preserveSelection: true,
    });
    downloadFile(patched, sourceFileName ?? `${model.name}.pdm`, 'application/xml');
    onClose();
  };

  if (!editable) {
    return (
      <div className="editor-overlay" onClick={onClose}>
        <div className="editor-modal editor-modal--narrow" onClick={(event) => event.stopPropagation()}>
          <header className="editor-modal__header">
            <div>
              <p className="eyebrow">Edición</p>
              <h2>No se puede editar</h2>
            </div>
            <button type="button" className="editor-modal__close" onClick={onClose}>
              ✕
            </button>
          </header>
          <p className="editor-modal__note">
            Este modelo no procede de un fichero .pdm de PowerDesigner, así que no hay XML original
            del que partir. Carga un .pdm para poder editarlo.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-overlay" onClick={onClose}>
      <div className="editor-modal" onClick={(event) => event.stopPropagation()}>
        <header className="editor-modal__header">
          <div>
            <p className="eyebrow">Editar tabla</p>
            <h2>{table.name}</h2>
          </div>
          <div className="editor-modal__header-actions">
            <span className="editor-modal__dirty">{dirty ? `${edits.length} cambio(s)` : 'sin cambios'}</span>
            <button type="button" className="editor-modal__close" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        <div className="editor-modal__body">
          <section className="editor-section">
            <h3>Tabla</h3>
            <div className="editor-grid">
              <label>
                <span>Nombre</span>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label>
                <span>Código</span>
                <input
                  type="text"
                  value={draft.code}
                  onChange={(event) => setDraft({ ...draft, code: event.target.value })}
                />
              </label>
              <label className="editor-grid__wide">
                <span>Comentario</span>
                <input
                  type="text"
                  value={draft.comment}
                  placeholder="(sin comentario)"
                  onChange={(event) => setDraft({ ...draft, comment: event.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="editor-section">
            <h3>Columnas ({draft.columns.length})</h3>
            <div className="editor-table-scroll">
              <table className="editor-table">
                <thead>
                  <tr>
                    <th>Código</th>
                    <th>Nombre</th>
                    <th>Tipo</th>
                    <th>Long.</th>
                    <th>NOT NULL</th>
                    <th>Comentario</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.columns.map((column, index) => (
                    <tr key={column.pdId ?? index}>
                      <td>
                        <input
                          type="text"
                          value={column.code}
                          onChange={(event) => updateColumn(index, { code: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={column.name}
                          onChange={(event) => updateColumn(index, { name: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={column.dataType}
                          onChange={(event) => updateColumn(index, { dataType: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="numeric"
                          className="editor-table__num"
                          value={column.length}
                          placeholder="—"
                          onChange={(event) => updateColumn(index, { length: event.target.value })}
                        />
                      </td>
                      <td className="editor-table__check">
                        <input
                          type="checkbox"
                          checked={column.mandatory}
                          onChange={(event) => updateColumn(index, { mandatory: event.target.checked })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={column.comment}
                          placeholder="—"
                          onChange={(event) => updateColumn(index, { comment: event.target.value })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <footer className="editor-modal__footer">
          <span className="editor-modal__hint">
            {sourceFileName ? `Se descargará «${sourceFileName}»` : ''}
            {!valid ? ' · completa los campos obligatorios' : ''}
          </span>
          <div className="editor-modal__buttons">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!valid || !dirty}
              onClick={handleSave}
            >
              Guardar y descargar .pdm
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
