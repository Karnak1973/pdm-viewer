import { useRef, useState } from 'react';
import { normalizeModel } from '../parser/normalizer';
import { parsePowerDesignerXml } from '../parser/xmlParser';
import { useModelStore } from '../state/modelStore';

export function FileDropZone() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setModel = useModelStore((state) => state.setModel);
  const [dragActive, setDragActive] = useState(false);
  const [status, setStatus] = useState('Arrastra un fichero .pdm o selecciónalo desde el equipo.');

  const loadFile = async (file: File | undefined) => {
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parsePowerDesignerXml(text);
      const model = normalizeModel(parsed, file.name.replace(/\.[^.]+$/, ''));
      setModel(model);
      setStatus(`Modelo cargado: ${model.name} (${model.tables.length} tablas)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo leer el archivo.';
      setStatus(message);
    }
  };

  return (
    <div
      className={`file-drop-zone ${dragActive ? 'dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        void loadFile(event.dataTransfer.files?.[0]);
      }}
      onClick={() => {
        inputRef.current?.click();
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdm,.xml"
        hidden
        onChange={(event) => {
          void loadFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <div className="file-drop-zone__label">+.pdm</div>
      <p>{status}</p>
    </div>
  );
}
