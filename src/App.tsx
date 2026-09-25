import { useEffect } from 'react';
import 'reactflow/dist/style.css';
import { FileDropZone } from './components/FileDropZone';
import { ERDiagram } from './components/Diagram/ERDiagram';
import { DetailPanel } from './components/DetailPanel/DetailPanel';
import { TableTree } from './components/Sidebar/TableTree';
import { useModelStore } from './state/modelStore';
import { createDemoModel } from './utils/sampleModel';
import './App.css';

function App() {
  const model = useModelStore((state) => state.model);
  const setModel = useModelStore((state) => state.setModel);

  useEffect(() => {
    if (model.tables.length === 0) {
      setModel(createDemoModel());
    }
  }, [model.tables.length, setModel]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">PowerDesigner</p>
          <h1>Visor de modelos .pdm</h1>
        </div>
        <span className="badge">solo lectura</span>
      </header>

      <main className="layout">
        <TableTree />

        <section className="workspace">
          <FileDropZone />
          <ERDiagram />
        </section>

        <DetailPanel />
      </main>
    </div>
  );
}

export default App;
