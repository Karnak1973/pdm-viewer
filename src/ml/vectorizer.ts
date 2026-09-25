/**
 * Motor de recuperación léxico-vectorial que funciona 100% en local.
 *
 * Cada documento se representa como un vector disperso TF-IDF sobre:
 *  - términos normalizados (peso 1)
 *  - sinónimos canónicos (peso 0.7)
 *  - trigramas de carácter (peso 0.25 repartido por token)
 *
 * La similitud combina coseno (parecido global) con cobertura (cuántos términos
 * de la consulta aparecen realmente en el documento), que da resultados mucho
 * más intuitivos con identificadores cortos.
 */

import { canonicalize, levenshteinSimilarity, tokenize } from './text';

const TOKEN_WEIGHT = 1;
const EXPANDED_WEIGHT = 0.7;
const COSINE_WEIGHT = 0.5;
const COVERAGE_WEIGHT = 0.25;
const FUZZY_WEIGHT = 0.25;
const FUZZY_THRESHOLD = 0.7;
const MIN_SCORE = 0.15;

export interface SearchDocument {
  id: string;
  /** Texto completo indexado: nombre, comentario, columnas y roles estructurales. */
  text: string;
  /**
   * Solo el nombre y el código del documento. Se usa para tolerar erratas,
   * porque los errores tipográficos del usuario se producen al recordar
   * nombres de tabla, no nombres de columna.
   */
  name?: string;
}

export interface SearchHit {
  id: string;
  score: number;
}

interface FeatureBag {
  features: Map<string, number>;
  /** Términos reducidos a su forma canónica, para medir cobertura semántica. */
  canonicalTerms: Set<string>;
  /** Términos tal cual aparecen, para la comparación por erratas. */
  tokens: string[];
}

/** Extrae las características ponderadas de un texto. */
function analyze(value: string): FeatureBag {
  const { tokens, expanded } = tokenize(value);
  const features = new Map<string, number>();
  const canonicalTerms = new Set<string>();

  const add = (term: string, weight: number) => {
    features.set(term, (features.get(term) ?? 0) + weight);
  };

  for (const token of tokens) {
    add(`t:${token}`, TOKEN_WEIGHT);
    canonicalTerms.add(canonicalize(token) ?? token);
  }

  for (const term of expanded) {
    add(`t:${term}`, EXPANDED_WEIGHT);
    canonicalTerms.add(term);
  }

  return { features, canonicalTerms, tokens };
}

interface PreparedDocument {
  id: string;
  vector: Map<string, number>;
  norm: number;
  canonicalTerms: Set<string>;
  tokens: string[];
  nameTokens: string[];
}

export class LexicalIndex {
  private readonly documents: PreparedDocument[] = [];

  private readonly idf = new Map<string, number>();

  private readonly documentCount: number;

  constructor(documents: SearchDocument[]) {
    const analyzed = documents.map((document) => ({
      id: document.id,
      bag: analyze(document.text),
      nameBag: analyze(document.name ?? document.text),
    }));

    this.documentCount = analyzed.length;

    const documentFrequency = new Map<string, number>();
    for (const { bag } of analyzed) {
      for (const term of bag.features.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }

    for (const [term, frequency] of documentFrequency) {
      this.idf.set(term, Math.log(1 + this.documentCount / (1 + frequency)));
    }

    for (const { id, bag, nameBag } of analyzed) {
      const vector = new Map<string, number>();
      let squared = 0;

      for (const [term, weight] of bag.features) {
        const value = weight * (this.idf.get(term) ?? this.fallbackIdf());
        vector.set(term, value);
        squared += value * value;
      }

      this.documents.push({
        id,
        vector,
        norm: Math.sqrt(squared),
        canonicalTerms: bag.canonicalTerms,
        tokens: bag.tokens,
        nameTokens: nameBag.tokens,
      });
    }
  }

  /** IDF asignado a términos de consulta que no existen en el corpus. */
  private fallbackIdf(): number {
    return Math.log(1 + this.documentCount / 1);
  }

  search(query: string, limit = 20): SearchHit[] {
    const queryBag = analyze(query);

    if (queryBag.features.size === 0) return [];

    const vector = new Map<string, number>();
    let squared = 0;

    for (const [term, weight] of queryBag.features) {
      const value = weight * (this.idf.get(term) ?? this.fallbackIdf());
      vector.set(term, value);
      squared += value * value;
    }

    const queryNorm = Math.sqrt(squared);
    if (queryNorm === 0) return [];

    const hits: SearchHit[] = [];

    for (const document of this.documents) {
      if (document.norm === 0) continue;

      let dot = 0;
      for (const [term, value] of vector) {
        const documentValue = document.vector.get(term);
        if (documentValue !== undefined) dot += value * documentValue;
      }

      const cosine = dot / (queryNorm * document.norm);

      let matched = 0;
      for (const term of queryBag.canonicalTerms) {
        if (document.canonicalTerms.has(term)) matched += 1;
      }
      const coverage = queryBag.canonicalTerms.size === 0 ? 0 : matched / queryBag.canonicalTerms.size;

      const fuzzy = fuzzyScore(queryBag.tokens, document.nameTokens);

      const score = Math.min(
        1,
        COSINE_WEIGHT * cosine + COVERAGE_WEIGHT * coverage + FUZZY_WEIGHT * fuzzy,
      );

      if (score > MIN_SCORE) hits.push({ id: document.id, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

/**
 * Media del mejor parecido por errata entre los términos de la consulta y los
 * términos del nombre del documento. Solo puntúa por encima de un umbral, para
 * que una coincidencia parcial pobre no se convierta en un falso positivo.
 */
function fuzzyScore(queryTokens: string[], nameTokens: string[]): number {
  if (queryTokens.length === 0 || nameTokens.length === 0) return 0;

  let total = 0;

  for (const queryToken of queryTokens) {
    let best = 0;

    for (const nameToken of nameTokens) {
      if (Math.abs(queryToken.length - nameToken.length) > 2) continue;

      const similarity = levenshteinSimilarity(queryToken, nameToken);
      if (similarity > best) best = similarity;
    }

    total += best >= FUZZY_THRESHOLD ? best : 0;
  }

  return total / queryTokens.length;
}

/** Similitud coseno entre dos vectores densos ya normalizados. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let index = 0; index < a.length && index < b.length; index += 1) {
    dot += a[index] * b[index];
  }
  return dot;
}

/** Normaliza un vector denso a norma unitaria (evita división por cero). */
export function normalizeVector(vector: number[]): number[] {
  let squared = 0;
  for (const value of vector) squared += value * value;

  const norm = Math.sqrt(squared);
  if (norm === 0) return vector.slice();

  return vector.map((value) => value / norm);
}
