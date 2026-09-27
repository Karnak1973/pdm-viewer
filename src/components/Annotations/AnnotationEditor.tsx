/**
 * Lista y editor de anotaciones de usuario para una tabla o columna.
 *
 * Se usa en el panel de detalles y puede reutilizarse en el diagrama.
 */

import { useState } from 'react';
import { useAnnotationStore } from '../../state/annotationStore';
import type { Annotation } from '../../state/annotationStore';

function AnnotationItem({ annotation }: { annotation: Annotation }) {
  const update = useAnnotationStore((state) => state.update);
  const remove = useAnnotationStore((state) => state.remove);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(annotation.text);

  const save = () => {
    if (draft.trim()) update(annotation.id, draft);
    setEditing(false);
  };

  const date = new Date(annotation.updatedAt).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });

  return (
    <li className="annotation__item">
      {editing ? (
        <textarea
          className="annotation__input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              save();
            }
            if (event.key === 'Escape') {
              setDraft(annotation.text);
              setEditing(false);
            }
          }}
          autoFocus
          rows={3}
        />
      ) : (
        <p className="annotation__text">{annotation.text}</p>
      )}

      <div className="annotation__meta">
        <time dateTime={new Date(annotation.updatedAt).toISOString()}>{date}</time>
        <span className="annotation__actions">
          {editing ? (
            <button type="button" onClick={save}>
              Guardar
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraft(annotation.text);
                setEditing(true);
              }}
            >
              Editar
            </button>
          )}
          <button
            type="button"
            className="annotation__delete"
            onClick={() => remove(annotation.id)}
          >
            Borrar
          </button>
        </span>
      </div>
    </li>
  );
}

export function AnnotationEditor({
  tableId,
  columnId,
  title,
}: {
  tableId: string;
  columnId?: string;
  title?: string;
}) {
  const annotations = useAnnotationStore((state) =>
    columnId ? state.forColumn(tableId, columnId) : state.forTable(tableId),
  );
  const add = useAnnotationStore((state) => state.add);

  const [text, setText] = useState('');

  const submit = () => {
    if (!text.trim()) return;
    add(tableId, columnId, text);
    setText('');
  };

  return (
    <div className="annotation">
      {title ? <h4 className="annotation__title">{title}</h4> : null}

      {annotations.length > 0 && (
        <ul className="annotation__list">
          {annotations.map((annotation) => (
            <AnnotationItem key={annotation.id} annotation={annotation} />
          ))}
        </ul>
      )}

      <div className="annotation__new">
        <textarea
          className="annotation__input"
          placeholder="Añadir anotación…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={2}
        />
        <button
          type="button"
          className="annotation__add"
          onClick={submit}
          disabled={!text.trim()}
        >
          +
        </button>
      </div>
    </div>
  );
}
