/**
 * Exportación de informes de lint a JSON, CSV y Markdown.
 */

import type { Model } from '../model/types';
import type { LintReport, LintIssue } from './modelLinter';
import { RULES_BY_ID } from './rules';

export type ExportFormat = 'json' | 'csv' | 'markdown';

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function issueRow(issue: LintIssue): Record<string, string> {
  const rule = RULES_BY_ID.get(issue.ruleId);
  return {
    severidad: issue.severity,
    regla: issue.ruleId,
    titulo: issue.title,
    detalle: issue.detail,
    tabla: issue.tableName ?? '',
    categoria: rule?.category ?? '',
  };
}

export function exportReportJson(model: Model, report: LintReport): string {
  const payload = {
    modelo: model.name,
    generado: new Date().toISOString(),
    puntuacion: report.score,
    conteos: report.counts,
    incidencias: report.issues.map((issue) => ({
      ...issueRow(issue),
      tableId: issue.tableId ?? null,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export function exportReportCsv(report: LintReport): string {
  const headers = ['severidad', 'regla', 'titulo', 'detalle', 'tabla', 'categoria'];
  const lines = [headers.join(',')];

  for (const issue of report.issues) {
    const row = issueRow(issue);
    lines.push(headers.map((key) => csvEscape(row[key])).join(','));
  }

  return lines.join('\r\n');
}

export function exportReportMarkdown(model: Model, report: LintReport): string {
  const lines: string[] = [];

  lines.push(`# Informe de calidad — ${model.name}`);
  lines.push('');
  lines.push(`- **Fecha:** ${new Date().toLocaleDateString('es-ES')}`);
  lines.push(`- **Puntuación:** ${report.score}/100`);
  lines.push(`- **Errores:** ${report.counts.error}`);
  lines.push(`- **Avisos:** ${report.counts.warning}`);
  lines.push(`- **Sugerencias:** ${report.counts.info}`);
  lines.push('');

  if (report.issues.length === 0) {
    lines.push('No se han encontrado incidencias.');
    return lines.join('\n');
  }

  const bySeverity: Record<string, LintIssue[]> = { error: [], warning: [], info: [] };
  for (const issue of report.issues) bySeverity[issue.severity].push(issue);

  const labels: Record<string, string> = { error: 'Errores', warning: 'Avisos', info: 'Sugerencias' };

  for (const severity of ['error', 'warning', 'info'] as const) {
    const issues = bySeverity[severity];
    if (issues.length === 0) continue;

    lines.push(`## ${labels[severity]} (${issues.length})`);
    lines.push('');
    lines.push('| Regla | Título | Tabla | Detalle |');
    lines.push('|-------|--------|-------|---------|');

    for (const issue of issues) {
      const rule = RULES_BY_ID.get(issue.ruleId);
      const title = rule ? `${issue.title}` : issue.title;
      lines.push(
        `| \`${issue.ruleId}\` | ${title} | ${issue.tableName ?? '—'} | ${issue.detail.replace(/\|/g, '\\|')} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function reportFilename(model: Model, format: ExportFormat): string {
  const safe = model.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'modelo';
  const ext = format === 'markdown' ? 'md' : format;
  return `informe-${safe}.${ext}`;
}

export function downloadFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
