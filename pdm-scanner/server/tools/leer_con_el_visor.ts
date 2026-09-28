/**
 * Lee un .pdm generado con el parser de la propia app web.
 *
 * Es una validación cruzada: el generador está en Python y este lector es
 * TypeScript, escrito aparte contra ficheros .pdm reales de PowerDesigner. Si
 * los dos coinciden, es muy improbable que el error sea del formato y no de
 * una lectura compartida.
 *
 *   npx vite-node pdm-scanner/server/tools/leer_con_el_visor.ts salida.pdm
 */

import { readFileSync } from 'node:fs';
import { parsePowerDesignerXml } from '../../../src/parser/xmlParser';
import { normalizeModel } from '../../../src/parser/normalizer';
import type { Model } from '../../../src/model/types';

const ruta = process.argv[2];
if (!ruta) {
  console.error('uso: vite-node leer_con_el_visor.ts <fichero.pdm>');
  process.exit(2);
}

const xml = readFileSync(ruta, 'utf8');
const modelo: Model = normalizeModel(parsePowerDesignerXml(xml), 'auditado');

console.log(`fichero:   ${ruta}`);
console.log(`modelo:    ${modelo.name}`);
console.log(`tablas:    ${modelo.tables.length}`);
console.log(`relaciones:${modelo.references.length}\n`);

let problemas = 0;

for (const tabla of modelo.tables) {
  const pk = tabla.keys.find((clave) => clave.isPrimary);
  const columnas = tabla.columns
    .map((columna) => {
      const etiquetas = [pk?.columns.includes(columna.id) ? 'PK' : '', columna.id];
      return etiquetas.filter(Boolean).join(' ');
    })
    .join('  ');

  console.log(`${tabla.code} (${tabla.name})`);
  console.log(`  PK: ${pk ? `(${pk.columns.join(', ')}) -> ${pk.name}` : 'NINGUNA'}`);
  console.log(`  ${columnas}`);
  for (const indice of tabla.indexes) {
    console.log(`  IDX ${indice.name} (${indice.columns.join(', ')}) unique=${indice.unique}`);
  }
  if (!pk) problemas += 1;
  if (tabla.columns.length === 0) problemas += 1;
  console.log('');
}

for (const referencia of modelo.references) {
  const padre = modelo.tables.find((t) => t.id === referencia.parentTable);
  const hija = modelo.tables.find((t) => t.id === referencia.childTable);
  const pc = referencia.joins
    .map((j) => padre?.columns.find((c) => c.id === j.parentColumn)?.name ?? '?')
    .join(', ');
  const hc = referencia.joins
    .map((j) => hija?.columns.find((c) => c.id === j.childColumn)?.name ?? '?')
    .join(', ');
  console.log(`FK ${referencia.name}: ${hija?.code}(${hc}) -> ${padre?.code}(${pc})`);
  if (!padre || !hija) problemas += 1;
  if (pc.includes('?') || hc.includes('?')) problemas += 1;
}

console.log(problemas === 0 ? '\nSIN PROBLEMAS' : `\n${problemas} PROBLEMA(S)`);
process.exit(problemas === 0 ? 0 : 1);

