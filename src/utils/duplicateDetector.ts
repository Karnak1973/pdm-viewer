/**
 * Detector de tablas potencialmente duplicadas.
 *
 * Compara cada par de tablas combinando tres señales independientes:
 *  - parecido de nombres y comentarios (con sinónimos ES/EN)
 *  - solapamiento de columnas
 *  - coincidencia de tipos de dato
 *
 * El resultado es una sugerencia para revisión, nunca una decisión automática.
 */

import type { Model, Table } from '../model/types';
import { canonicalTermSet, diceCoefficient, jaccard } from '../ml/text';

export type DuplicateVerdict = 'high' | 'medium';

export interface DuplicateCandidate {
  a: { id: string; name: string };
  b: { id: string; name: string };
  score: number;
  verdict: DuplicateVerdict;
  reasons: string[];
}

export interface DuplicateReport {
  candidates: DuplicateCandidate[];
  comparedPairs: number;
}

const HIGH_THRESHOLD = 0.72;
const MEDIUM_THRESHOLD = 0.55;

/** Clave canónica de una columna: sus términos canónicos ordenados. */
function columnKey(columCode: string): string {
  return [...canonicalTermSet(columCode)].sort().join('+');
}

/** Todos los términos canónicos presentes en una tabla. */
function tableVocabulary(table: Table): Set<string> {
  const terms = canonicalTermSet(`${table.name} ${table.code} ${table.comment ?? ''}`);
  for (const column of table.columns) {
    for (const term of canonicalTermSet(column.code)) terms.add(term);
  }
  return terms;
}

/** Puntuación del parecido de nombres. */
function nameScore(a: Table, b: Table): number {
  const termsA = canonicalTermSet(`${a.name} ${a.code} ${a.comment ?? ''}`);
  const termsB = canonicalTermSet(`${b.name} ${b.code} ${b.comment ?? ''}`);
  const semantic = jaccard(termsA, termsB);

  const charA = a.code.toLowerCase().replace(/[^a-z0-9]/g, '');
  const charB = b.code.toLowerCase().replace(/[^a-z0-9]/g, '');
  const spelling = diceCoefficient(charA, charB);

  return Math.max(semantic, 0.6 * spelling + 0.4 * semantic);
}

/** Puntuación del solapamiento de columnas. */
function columnScore(a: Table, b: Table): number {
  const keysA = new Set(a.columns.map((column) => columnKey(column.code)));
  const keysB = new Set(b.columns.map((column) => columnKey(column.code)));

  let exactMatches = 0;
  for (const key of keysA) {
    if (keysB.has(key)) exactMatches += 1;
  }

  const largest = Math.max(keysA.size, keysB.size, 1);
  const exactRatio = exactMatches / largest;
  const vocabulary = jaccard(tableVocabulary(a), tableVocabulary(b));

  return 0.5 * exactRatio + 0.5 * vocabulary;
}

/** Proporción de columnas con el mismo nombre que comparten tipo de dato. */
function typeScore(a: Table, b: Table): number {
  const mapA = new Map(a.columns.map((column) => [columnKey(column.code), column.dataType.toLowerCase()]));
  const mapB = new Map(b.columns.map((column) => [columnKey(column.code), column.dataType.toLowerCase()]));

  let shared = 0;
  let sameType = 0;

  for (const [key, dataType] of mapA) {
    const other = mapB.get(key);
    if (other !== undefined) {
      shared += 1;
      if (other === dataType) sameType += 1;
    }
  }

  return shared === 0 ? 0 : sameType / shared;
}

function buildReasons(
  a: Table,
  b: Table,
  name: number,
  columns: number,
  types: number,
): string[] {
  const reasons: string[] = [];

  if (name >= 0.8) reasons.push('Nombres prácticamente idénticos');
  else if (name >= 0.5) reasons.push('Nombres relacionados semánticamente');

  const keysA = new Set(a.columns.map((column) => columnKey(column.code)));
  const keysB = new Set(b.columns.map((column) => columnKey(column.code)));
  let exact = 0;
  for (const key of keysA) {
    if (keysB.has(key)) exact += 1;
  }
  if (exact > 0) {
    reasons.push(`${exact} columna${exact === 1 ? '' : 's'} con el mismo nombre`);
  }
  if (columns >= 0.6) reasons.push('Vocabulario de columnas muy solapado');
  if (types >= 0.8 && exact > 0) reasons.push('Tipos de dato coincidentes');

  if (reasons.length === 0) reasons.push('Similitud estructural moderada');

  return reasons;
}

/** Analiza el modelo completo y devuelve pares candidatos ordenados por score. */
export function detectDuplicates(model: Model): DuplicateReport {
  const candidates: DuplicateCandidate[] = [];
  const tables = model.tables;
  let comparedPairs = 0;

  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const a = tables[i];
      const b = tables[j];
      comparedPairs += 1;

      const name = nameScore(a, b);
      const columns = columnScore(a, b);
      const types = typeScore(a, b);
      const score = 0.45 * name + 0.45 * columns + 0.1 * types;

      if (score < MEDIUM_THRESHOLD) continue;

      candidates.push({
        a: { id: a.id, name: a.name },
        b: { id: b.id, name: b.name },
        score: Number(score.toFixed(3)),
        verdict: score >= HIGH_THRESHOLD ? 'high' : 'medium',
        reasons: buildReasons(a, b, name, columns, types),
      });
    }
  }

  candidates.sort((first, second) => second.score - first.score);

  return { candidates, comparedPairs };
}
