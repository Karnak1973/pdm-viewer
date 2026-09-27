import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeModel } from './normalizer';
import { parsePowerDesignerXml } from './xmlParser';
import { applyPdmEdits } from './xmlPatch';
import { buildTableEdits, toTableDraft } from '../utils/pdmEdits';

const sourceXml = readFileSync(new URL('../../examples/example.pdm', import.meta.url), 'utf8');
const sourceModel = normalizeModel(parsePowerDesignerXml(sourceXml), 'example');

function reload(xml: string) {
  return normalizeModel(parsePowerDesignerXml(xml), 'example');
}

describe('guardado y recarga del .pdm real', () => {
  it('renombra una tabla sin perder nada más', () => {
    const table = sourceModel.tables[0];
    const draft = { ...toTableDraft(table), name: 'Clientes' };
    const patched = applyPdmEdits(sourceXml, buildTableEdits(table, draft));
    const reloaded = reload(patched);

    expect(reloaded.tables).toHaveLength(2);
    expect(reloaded.tables[0].name).toBe('Clientes');
    expect(reloaded.tables[0].code).toBe('Table_1');
    expect(reloaded.tables[1].name).toBe('Table_2');
    expect(reloaded.references).toEqual(sourceModel.references);
    expect(reloaded.tables[1]).toEqual(sourceModel.tables[1]);
    expect(patched.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(patched).toContain('signature="PDM_DATA_MODEL_XML"');
  });

  it('cambia un tipo de dato y lo ve el parser al recargar', () => {
    const table = sourceModel.tables[0];
    const draft = toTableDraft(table);
    draft.columns[1].dataType = 'VARCHAR';
    draft.columns[1].length = '120';

    const patched = applyPdmEdits(sourceXml, buildTableEdits(table, draft));
    const reloaded = reload(patched);

    expect(reloaded.tables[0].columns[1].dataType).toBe('VARCHAR');
    expect(reloaded.tables[0].columns[1].length).toBe(120);
    expect(reloaded.tables[0].columns[0]).toEqual(sourceModel.tables[0].columns[0]);
  });

  it('quita y vuelve a poner NOT NULL', () => {
    const table = sourceModel.tables[0];
    const without = toTableDraft(table);
    without.columns[0].mandatory = false;

    const firstPass = applyPdmEdits(sourceXml, buildTableEdits(table, without));
    expect(reload(firstPass).tables[0].columns[0].mandatory).toBe(false);

    const tableAfter = reload(firstPass).tables[0];
    const withNull = toTableDraft(tableAfter);
    withNull.columns[0].mandatory = true;

    const secondPass = applyPdmEdits(firstPass, buildTableEdits(tableAfter, withNull));
    expect(reload(secondPass).tables[0].columns[0].mandatory).toBe(true);
    expect(secondPass.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it('mantiene el conteo de objetos del modelo', () => {
    const table = sourceModel.tables[1];
    const draft = { ...toTableDraft(table), name: 'Facturas', code: 'Facturas' };
    const patched = applyPdmEdits(sourceXml, buildTableEdits(table, draft));
    const reloaded = reload(patched);

    expect(patched.match(/<o:Table Id=/g)).toHaveLength(sourceXml.match(/<o:Table Id=/g)!.length);
    expect(patched.match(/<o:Column Id=/g)).toHaveLength(sourceXml.match(/<o:Column Id=/g)!.length);
    expect(patched.match(/<o:Reference Id=/g)).toHaveLength(sourceXml.match(/<o:Reference Id=/g)!.length);
    expect(reloaded.tables[1].name).toBe('Facturas');
    expect(reloaded.tables[1].code).toBe('Facturas');
    expect(reloaded.tables[1].pdId).toBe(sourceModel.tables[1].pdId);
  });

  it('sin cambios devuelve el XML idéntico', () => {
    const patched = applyPdmEdits(sourceXml, buildTableEdits(sourceModel.tables[0], toTableDraft(sourceModel.tables[0])));
    expect(patched).toBe(sourceXml);
  });
});
