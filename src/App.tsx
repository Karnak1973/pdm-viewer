import { useEffect, useMemo } from 'react';
import 'reactflow/dist/style.css';
import { FileDropZone } from './components/FileDropZone';
import { ERDiagram } from './components/Diagram/ERDiagram';
import { DetailPanel } from './components/DetailPanel/DetailPanel';
import { TableTree } from './components/Sidebar/TableTree';
import { AnalysisPanel } from './components/Analysis/AnalysisPanel';
import { useModelStore } from './state/modelStore';
import { lintModel } from './utils/modelLinter';
import { createDemoModel } from './utils/sampleModel';
import './App.css';

function App() {
  const model = useModelStore((state) => state.model);
  const setModel = useModelStore((state) => state.setModel);
  const view = useModelStore((state) => state.view);
  const setView = useModelStore((state) => state.setView);

  useEffect(() => {
    if (model.tables.length === 0) {
      setModel(createDemoModel());
    }
  }, [model.tables.length, setModel]);

  const report = useMemo(() => lintModel(model), [model]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <div className="app-header__logo" aria-label="Logo del visor">PD</div>
          <div>
            <p className="eyebrow">PowerDesigner</p>
            <h1>Visor de modelos .pdm</h1>
          </div>
        </div>

        <div className="app-header__meta">
          <span className="badge badge--blue">solo lectura</span>
          <span className={`badge badge--health ${report.counts.error > 0 ? 'has-errors' : ''}`}>
            salud {report.score}/100
          </span>
        </div>
      </header>

      <main className="layout">
        <TableTree />

        <section className="workspace">
          <FileDropZone />

          <div className="workspace__tabs" role="tablist" aria-label="Vistas del área de trabajo">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'diagram'}
              className={view === 'diagram' ? 'active' : ''}
              onClick={() => setView('diagram')}
            >
              Diagrama
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'analysis'}
              className={view === 'analysis' ? 'active' : ''}
              onClick={() => setView('analysis')}
            >
              Análisis
              {report.issues.length > 0 ? (
                <span className={`workspace__tab-badge ${report.counts.error > 0 ? 'error' : 'warning'}`}>
                  {report.issues.length}
                </span>
              ) : null}
            </button>
          </div>

          {view === 'diagram' ? <ERDiagram /> : <AnalysisPanel model={model} />}
        </section>

        <DetailPanel />
      </main>
    </div>
  );
}

export default App;
