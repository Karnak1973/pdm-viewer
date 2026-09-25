import { describe, expect, it } from 'vitest';
import type { Model, Table } from '../model/types';
import { detectDuplicates } from './duplicateDetector';
import { createDemoModel } from './sampleModel';

function table(id: string, code: string, columns: string[], dataType = 'VARCHAR'): Table {
  return {
    id,
    code,
    name: code,
    columns: columns.map((columnCode, index) => ({
      id: `${id}-c${index}`,
      code: columnCode,
      name: columnCode,
      dataType,
      length: 100,
      mandatory: index === 0,
      identity: index === 0,
    })),
    primaryKey: [`${id}-c0`],
    keys: [],
    indexes: [],
  };
}

function modelWith(tables: Table[]): Model {
  return { name: 'Test', tables, references: [], domains: [] };
}

describe('detectDuplicates', () => {
  it('no marca el modelo de ejemplo como duplicado', () => {
    const report = detectDuplicates(createDemoModel());
    expect(report.candidates).toEqual([]);
    expect(report.comparedPairs).toBe(3);
  });

  it('detecta dos tablas idénticas como duplicado de alta confianza', () => {
    const report = detectDuplicates(
      modelWith([
        table('a', 'Customer', ['CustomerID', 'FirstName', 'LastName', 'Email']),
        table('b', 'Customer', ['CustomerID', 'FirstName', 'LastName', 'Email']),
      ]),
    );

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].verdict).toBe('high');
    expect(report.candidates[0].score).toBeGreaterThan(0.9);
  });

  it('detecta Customer y Client con las mismas columnas', () => {
    const report = detectDuplicates(
      modelWith([
        table('a', 'Customer', ['CustomerID', 'FirstName', 'LastName', 'Email']),
        table('b', 'Client', ['ClientID', 'FirstName', 'LastName', 'Email']),
      ]),
    );

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].verdict).toBe('high');
    expect(report.candidates[0].reasons.length).toBeGreaterThan(0);
  });

  it('relaciona tablas con nombres sinónimos aunque no coincidan las columnas', () => {
    const report = detectDuplicates(
      modelWith([
        table('a', 'Invoice', ['InvoiceID', 'Total', 'IssuedAt']),
        table('b', 'Factura', ['FacturaID', 'Importe', 'Fecha']),
      ]),
    );

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].reasons.join(' ')).toContain('Nombres');
  });

  it('no marca tablas sin relación', () => {
    const report = detectDuplicates(
      modelWith([
        table('a', 'Customer', ['CustomerID', 'Email']),
        table('b', 'Product', ['ProductID', 'Price', 'Stock']),
      ]),
    );

    expect(report.candidates).toEqual([]);
  });

  it('ordena los candidatos por score descendente', () => {
    const report = detectDuplicates(
      modelWith([
        table('a', 'Customer', ['CustomerID', 'FirstName', 'LastName', 'Email']),
        table('b', 'Customer', ['CustomerID', 'FirstName', 'LastName', 'Email']),
        table('c', 'Client', ['ClientID', 'FirstName', 'LastName', 'Email']),
      ]),
    );

    expect(report.candidates.length).toBeGreaterThan(1);
    for (let position = 1; position < report.candidates.length; position += 1) {
      expect(report.candidates[position - 1].score).toBeGreaterThanOrEqual(report.candidates[position].score);
    }
  });
});
