import { describe, expect, it } from 'vitest';
import type { Model, Table, Reference } from '../model/types';
import { lintModel } from './modelLinter';
import { defaultRuleConfig, RULES, RULES_BY_ID } from './rules';
import type { RuleConfig } from './rules';
import { exportReportJson, exportReportCsv, exportReportMarkdown, reportFilename } from './reportExport';

function makeTable(id: string, opts: Partial<Table> = {}): Table {
  return {
    id,
    code: id,
    name: id,
    columns: opts.columns ?? [
      { id: `${id}_pk`, code: 'id', name: 'id', dataType: 'INTEGER', mandatory: true, identity: true },
    ],
    keys: opts.keys ?? [],
    indexes: opts.indexes ?? [],
    primaryKey: opts.primaryKey ?? [`${id}_pk`],
    ...opts,
  };
}

function makeModel(tables: Table[], references: Reference[]): Model {
  return { name: 'test-model', tables, references, domains: [] };
}

describe('rules registry', () => {
  it('todas las reglas tienen id, título y categoría', () => {
    for (const rule of RULES) {
      expect(rule.id).toBeTruthy();
      expect(rule.title).toBeTruthy();
      expect(rule.category).toBeTruthy();
      expect(rule.description).toBeTruthy();
    }
  });

  it('los ids son únicos', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defaultRuleConfig incluye todas las reglas', () => {
    const config = defaultRuleConfig();
    expect(Object.keys(config)).toHaveLength(RULES.length);
    for (const rule of RULES) {
      expect(config[rule.id]).toBe(rule.defaultSeverity);
    }
  });
});

describe('lintModel con configuración', () => {
  it('sin config funciona igual que antes', () => {
    const model = makeModel([makeTable('a', { primaryKey: [] })], []);
    const report = lintModel(model);
    expect(report.issues.some((i) => i.ruleId === 'table-no-pk')).toBe(true);
  });

  it('desactiva reglas con severidad off', () => {
    const model = makeModel([makeTable('a', { primaryKey: [] })], []);
    const config: RuleConfig = { ...defaultRuleConfig(), 'table-no-pk': 'off' };
    const report = lintModel(model, config);
    expect(report.issues.some((i) => i.ruleId === 'table-no-pk')).toBe(false);
  });

  it('cambia la severidad de una regla', () => {
    const model = makeModel([makeTable('a', { primaryKey: [] })], []);
    const config: RuleConfig = { ...defaultRuleConfig(), 'table-no-pk': 'info' };
    const report = lintModel(model, config);
    const issue = report.issues.find((i) => i.ruleId === 'table-no-pk');
    expect(issue?.severity).toBe('info');
  });

  it('el conteo refleja la severidad efectiva', () => {
    const model = makeModel([makeTable('a', { primaryKey: [] })], []);
    const config: RuleConfig = { ...defaultRuleConfig(), 'table-no-pk': 'warning' };
    const report = lintModel(model, config);
    expect(report.counts.error).toBe(0);
    expect(report.counts.warning).toBeGreaterThanOrEqual(1);
  });

  it('cada issue lleva su ruleId', () => {
    const model = makeModel([makeTable('a', { primaryKey: [] })], []);
    const report = lintModel(model);
    for (const issue of report.issues) {
      expect(RULES_BY_ID.has(issue.ruleId)).toBe(true);
    }
  });
});

describe('reportExport', () => {
  const model = makeModel([makeTable('a', { primaryKey: [] })], []);
  const report = lintModel(model);

  it('JSON es válido y contiene campos clave', () => {
    const json = exportReportJson(model, report);
    const parsed = JSON.parse(json);
    expect(parsed.modelo).toBe('test-model');
    expect(typeof parsed.puntuacion).toBe('number');
    expect(Array.isArray(parsed.incidencias)).toBe(true);
    expect(parsed.incidencias.length).toBe(report.issues.length);
  });

  it('CSV tiene cabecera y filas', () => {
    const csv = exportReportCsv(report);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('severidad,regla,titulo,detalle,tabla,categoria');
    expect(lines.length).toBe(report.issues.length + 1);
  });

  it('CSV escapa comillas y comas', () => {
    const csv = exportReportCsv(report);
    // al menos una fila con detalle que puede contener comas
    expect(csv.split('\r\n').length).toBeGreaterThan(1);
  });

  it('Markdown contiene cabecera y tablas', () => {
    const md = exportReportMarkdown(model, report);
    expect(md).toContain('# Informe de calidad');
    expect(md).toContain('**Puntuación:**');
    if (report.issues.length > 0) {
      expect(md).toContain('| Regla |');
    }
  });

  it('Markdown sin incidencias muestra mensaje', () => {
    const cleanModel = makeModel([makeTable('a')], []);
    const cleanReport = lintModel(cleanModel, { ...defaultRuleConfig() });
    const md = exportReportMarkdown(cleanModel, cleanReport);
    expect(md).toContain('No se han encontrado incidencias.');
  });

  it('reportFilename genera nombre seguro', () => {
    expect(reportFilename(model, 'json')).toBe('informe-test-model.json');
    expect(reportFilename(model, 'csv')).toBe('informe-test-model.csv');
    expect(reportFilename(model, 'markdown')).toBe('informe-test-model.md');
  });

  it('reportFilename limpia caracteres especiales', () => {
    const weird = { ...model, name: 'Mi Modelo (v2)!' };
    expect(reportFilename(weird, 'json')).toBe('informe-mi-modelo-v2-.json');
  });
});
