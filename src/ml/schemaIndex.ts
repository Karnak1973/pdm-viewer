/**
 * Índice semántico del esquema.
 *
 * Estrategia en dos niveles:
 *  1. `lexical` (por defecto): índice TF-IDF local, disponible al instante y sin red.
 *  2. `neural`: embeddings de Transformers.js, descargados solo si el usuario los
 *     pide, cacheados en IndexedDB y combinados con el motor léxico.
 *
 * El nivel neuronal nunca es obligatorio: si falla, el índice sigue siendo útil.
 */

import type { Model, Table } from '../model/types';
import { readCache, writeCache } from './cache';
import { embedTexts } from '@neural';
import type { EmbeddingProgress } from './neuralContract';
import { LexicalIndex, cosineSimilarity, type SearchDocument } from './vectorizer';

const CACHE_VERSION = 'v1';
const NEURAL_WEIGHT = 0.7;
const LEXICAL_WEIGHT = 0.3;

export type SearchMode = 'lexical' | 'loading' | 'neural' | 'error';

export interface SemanticResult {
  id: string;
  /** Afinidad relativa 0..1 respecto al mejor resultado de la consulta. */
  score: number;
}

/** Convierte una tabla en el texto que se indexa y se vectoriza. */
export function buildTableText(table: Table, model: Model): string {
  const parts: string[] = [table.name, table.code];

  if (table.comment) parts.push(table.comment);

  for (const column of table.columns) {
    parts.push(column.name, column.code, column.dataType);
    if (column.comment) parts.push(column.comment);
  }

  // Enriquecimiento semántico: palabras que describen el rol estructural.
  if (table.primaryKey && table.primaryKey.length > 0) parts.push('clave primaria primary key identificador');

  for (const reference of model.references) {
    if (reference.childTable === table.id) {
      const parent = model.tables.find((candidate) => candidate.id === reference.parentTable);
      parts.push('clave foranea foreign key relacion');
      if (parent) parts.push(parent.name, parent.code);
    }
    if (reference.parentTable === table.id) {
      const child = model.tables.find((candidate) => candidate.id === reference.childTable);
      parts.push('referenciada por dependencia');
      if (child) parts.push(child.name, child.code);
    }
  }

  if (table.indexes.length > 0) parts.push('indice index');

  return parts.join(' ');
}

/** Firma corta del modelo, usada como clave de caché de embeddings. */
export function modelSignature(model: Model): string {
  const source = [
    model.name,
    ...model.tables.map((table) => `${table.id}:${table.code}:${table.columns.length}`),
    ...model.references.map((reference) => reference.id),
  ].join('|');

  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Reescala una lista de puntuaciones al rango 0..1 según el mejor resultado. */
function rescale(hits: { id: string; score: number }[]): SemanticResult[] {
  if (hits.length === 0) return [];

  const best = Math.max(...hits.map((hit) => hit.score));
  if (best <= 0) return hits.map((hit) => ({ id: hit.id, score: 0 }));

  return hits.map((hit) => ({
    id: hit.id,
    score: Math.max(0, Math.min(1, hit.score / best)),
  }));
}

export class SchemaIndex {
  private readonly documents: SearchDocument[];

  private readonly lexical: LexicalIndex;

  private readonly signature: string;

  private mode: SearchMode = 'lexical';

  private neuralVectors: Map<string, number[]> | null = null;

  constructor(model: Model) {
    this.signature = modelSignature(model);
    this.documents = model.tables.map((table) => ({
      id: table.id,
      text: buildTableText(table, model),
      name: `${table.name} ${table.code} ${table.comment ?? ''}`,
    }));
    this.lexical = new LexicalIndex(this.documents);
  }

  getMode(): SearchMode {
    return this.mode;
  }

  get tableCount(): number {
    return this.documents.length;
  }

  /** Búsqueda instantánea con el motor léxico. */
  private searchLexical(query: string, limit: number): SemanticResult[] {
    return this.lexical.search(query, limit).map((hit) => ({ id: hit.id, score: hit.score }));
  }

  /** Búsqueda neuronal: coseno sobre embeddings + desempate léxico. */
  private searchNeural(query: string, limit: number, queryVector: number[]): SemanticResult[] {
    const vectors = this.neuralVectors;
    if (!vectors) return this.searchLexical(query, limit);

    const lexicalScores = new Map(
      this.lexical.search(query, this.documents.length).map((hit) => [hit.id, hit.score]),
    );

    const blended: { id: string; score: number }[] = [];

    for (const document of this.documents) {
      const vector = vectors.get(document.id);
      if (!vector) continue;

      const similarity = cosineSimilarity(queryVector, vector);
      const lexical = lexicalScores.get(document.id) ?? 0;
      blended.push({ id: document.id, score: NEURAL_WEIGHT * similarity + LEXICAL_WEIGHT * lexical });
    }

    blended.sort((a, b) => b.score - a.score);

    // Solo se conservan los resultados con señal léxica o coseno apreciable.
    const filtered = blended.filter(
      (hit, index) => index < 3 || hit.score > 0 || (lexicalScores.get(hit.id) ?? 0) > 0,
    );

    return rescale(filtered.slice(0, limit));
  }

  /** Búsqueda síncrona sobre los vectores ya calculados. */
  search(query: string, limit = 20, queryVector?: number[]): SemanticResult[] {
    if (query.trim().length === 0) return [];

    if (this.mode === 'neural' && queryVector) {
      return this.searchNeural(query, limit, queryVector);
    }

    return this.searchLexical(query, limit);
  }

  /** Devuelve el embedding de la consulta cuando el modo neuronal está activo. */
  async embedQuery(query: string): Promise<number[] | null> {
    if (this.mode !== 'neural') return null;
    const [vector] = await embedTexts([query]);
    return vector ?? null;
  }

  /**
   * Activa el motor neuronal. Carga el modelo, reutiliza embeddings cacheados
   * por firma de modelo y actualiza el modo interno.
   */
  async enableNeural(onProgress?: (progress: EmbeddingProgress) => void): Promise<SearchMode> {
    if (this.mode === 'neural') return this.mode;
    if (this.documents.length === 0) return this.mode;

    this.mode = 'loading';

    try {
      const cacheKey = `vectors:${CACHE_VERSION}:${this.signature}`;
      const cached = await readCache<Record<string, number[]>>(cacheKey);

      if (cached && this.isCacheComplete(cached)) {
        this.neuralVectors = new Map(Object.entries(cached));
        this.mode = 'neural';
        onProgress?.({ stage: 'ready', message: 'Embeddings recuperados de la caché' });
        return this.mode;
      }

      const vectors = await embedTexts(
        this.documents.map((document) => document.text),
        onProgress,
      );

      const record: Record<string, number[]> = {};
      this.documents.forEach((document, index) => {
        record[document.id] = vectors[index] ?? [];
      });

      this.neuralVectors = new Map(Object.entries(record));
      this.mode = 'neural';

      void writeCache(cacheKey, record);
      return this.mode;
    } catch (error) {
      this.mode = 'error';
      this.neuralVectors = null;
      onProgress?.({
        stage: 'error',
        message: error instanceof Error ? error.message : 'Error al calcular embeddings',
      });
      return this.mode;
    }
  }

  /** Comprueba que la caché cubre todas las tablas actuales con vectores válidos. */
  private isCacheComplete(cached: Record<string, number[]>): boolean {
    return this.documents.every((document) => {
      const vector = cached[document.id];
      return Array.isArray(vector) && vector.length > 0;
    });
  }

  /**
   * Desactiva el motor neuronal y libera los vectores en memoria.
   *
   * Es imprescindible hacerlo al retirar la autorización: si el índice siguiera
   * en modo neuronal, la siguiente consulta volvería a descargar el modelo sin
   * que el usuario lo hubiera pedido.
   */
  disableNeural(): void {
    this.neuralVectors = null;
    this.mode = 'lexical';
  }
}

/** Crea el índice semántico de un modelo. */
export function createSchemaIndex(model: Model): SchemaIndex {
  return new SchemaIndex(model);
}
