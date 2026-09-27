/**
 * Botones de exportación del informe de lint.
 */

import { useState } from 'react';
import type { LintReport } from '../../utils/modelLinter';
import type { Model } from '../../model/types';
import type { ExportFormat } from '../../utils/reportExport';
import {
  exportReportJson,
  exportReportCsv,
  exportReportMarkdown,
  reportFilename,
  downloadFile,
} from '../../utils/reportExport';

const FORMATS: { id: ExportFormat; label: string; mime: string }[] = [
  { id: 'json', label: 'JSON', mime: 'application/json' },
  { id: 'csv', label: 'CSV', mime: 'text/csv' },
  { id: 'markdown', label: 'Markdown', mime: 'text/markdown' },
];

const COPYABLE: ExportFormat[] = ['json', 'csv', 'markdown'];

export function ReportExport({ model, report }: { model: Model; report: LintReport }) {
  const [copied, setCopied] = useState<ExportFormat | null>(null);

  const generate = (format: ExportFormat): string => {
    if (format === 'json') return exportReportJson(model, report);
    if (format === 'csv') return exportReportCsv(report);
    return exportReportMarkdown(model, report);
  };

  const handleDownload = (format: ExportFormat) => {
    const content = generate(format);
    const formatInfo = FORMATS.find((f) => f.id === format)!;
    downloadFile(content, reportFilename(model, format), formatInfo.mime);
  };

  const handleCopy = async (format: ExportFormat) => {
    try {
      await navigator.clipboard.writeText(generate(format));
      setCopied(format);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      // portapapeles no disponible
    }
  };

  return (
    <div className="report-export">
      <span className="report-export__label">Exportar</span>
      {FORMATS.map((format) => (
        <div key={format.id} className="report-export__group">
          <button type="button" onClick={() => handleDownload(format.id)}>
            ⬇ {format.label}
          </button>
          {COPYABLE.includes(format.id) && (
            <button
              type="button"
              className="report-export__copy"
              onClick={() => void handleCopy(format.id)}
              title="Copiar al portapapeles"
            >
              {copied === format.id ? '✓' : '⧉'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
