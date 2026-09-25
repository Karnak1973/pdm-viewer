/**
 * Panel de análisis del modelo: salud del esquema y tablas potencialmente duplicadas.
 */

import { useMemo, useState } from 'react';
import type { Model } from '../../model/types';
import { useModelStore } from '../../state/modelStore';
import { detectDuplicates } from '../../utils/duplicateDetector';
import { lintModel, severityLabel, type IssueSeverity } from '../../utils/modelLinter';

type SeverityFilter = IssueSeverity | 'all';

function scoreTone(score: number): 'good' | 'fair' | 'poor' {
  if (score >= 85) return 'good';
  if (score >= 65) return 'fair';
  return 'poor';
}

export function AnalysisPanel({ model }: { model: Model }) {
  const setSelectedTable = useModelStore((state) => state.setSelectedTable);
  const setView = useModelStore((state) => state.setView);

  const [filter, setFilter] = useState<SeverityFilter>('all');

  const report = useMemo(() => lintModel(model), [model]);
  const duplicates = useMemo(() => detectDuplicates(model), [model]);

  const issues = useMemo(
    () => (filter === 'all' ? report.issues : report.issues.filter((issue) => issue.severity === filter)),
    [report.issues, filter],
  );

  const tone = scoreTone(report.score);

  const openTable = (tableId: string) => {
    setSelectedTable(tableId);
    setView('diagram');
  };

  return (
    <section className="analysis">
      <div className="analysis__score">
        <div className={`analysis__gauge ${tone}`}>
          <span className="analysis__value">{report.score}</span>
          <span className="analysis__unit">/ 100</span>
        </div>
        <div className="analysis__score-text">
          <h2>Salud del esquema</h2>
          <p>
            Puntuación calculada a partir de {model.tables.length} tablas y{' '}
            {model.tables.reduce((total, table) => total + table.columns.length, 0)} columnas.
          </p>
          <div className="analysis__counters">
            <button
              type="button"
              className={filter === 'error' ? 'counter error active' : 'counter error'}
              onClick={() => setFilter(filter === 'error' ? 'all' : 'error')}
            >
              <strong>{report.counts.error}</strong> errores
            </button>
            <button
              type="button"
              className={filter === 'warning' ? 'counter warning active' : 'counter warning'}
              onClick={() => setFilter(filter === 'warning' ? 'all' : 'warning')}
            >
              <strong>{report.counts.warning}</strong> avisos
            </button>
            <button
              type="button"
              className={filter === 'info' ? 'counter info active' : 'counter info'}
              onClick={() => setFilter(filter === 'info' ? 'all' : 'info')}
            >
              <strong>{report.counts.info}</strong> sugerencias
            </button>
          </div>
        </div>
      </div>

      <div className="analysis__grid">
        <div className="analysis__card">
          <header className="analysis__card-header">
            <h3>Incidencias</h3>
            <span>{issues.length}</span>
          </header>

          {issues.length === 0 ? (
            <p className="analysis__empty">
              {report.issues.length === 0
                ? 'No se han encontrado problemas en el modelo.'
                : 'No hay incidencias con ese filtro.'}
            </p>
          ) : (
            <ul className="issue-list">
              {issues.map((issue) => (
                <li key={issue.id} className={`issue-list__item ${issue.severity}`}>
                  <div className="issue-list__top">
                    <span className={`issue-list__severity ${issue.severity}`}>
                      {severityLabel(issue.severity)}
                    </span>
                    <strong>{issue.title}</strong>
                  </div>
                  <p>{issue.detail}</p>
                  {issue.tableId ? (
                    <button
                      type="button"
                      className="issue-list__link"
                      onClick={() => openTable(issue.tableId as string)}
                    >
                      Ver {issue.tableName}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="analysis__card">
          <header className="analysis__card-header">
            <h3>Tablas duplicadas</h3>
            <span>{duplicates.candidates.length}</span>
          </header>

          <p className="analysis__hint">
            Comparadas {duplicates.comparedPairs} parejas combinando nombres, sinónimos y columnas.
          </p>

          {duplicates.candidates.length === 0 ? (
            <p className="analysis__empty">No hay tablas sospechosas de estar duplicadas.</p>
          ) : (
            <ul className="duplicate-list">
              {duplicates.candidates.map((candidate) => (
                <li key={`${candidate.a.id}-${candidate.b.id}`} className={`duplicate-list__item ${candidate.verdict}`}>
                  <div className="duplicate-list__top">
                    <button type="button" onClick={() => openTable(candidate.a.id)}>
                      {candidate.a.name}
                    </button>
                    <span className="duplicate-list__link-icon">↔</span>
                    <button type="button" onClick={() => openTable(candidate.b.id)}>
                      {candidate.b.name}
                    </button>
                    <span className="duplicate-list__score">{Math.round(candidate.score * 100)}%</span>
                  </div>
                  <ul className="duplicate-list__reasons">
                    {candidate.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
