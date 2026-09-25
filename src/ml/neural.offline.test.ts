/**
 * Tests del motor deshabilitado que se entrega en la compilación de trabajo.
 *
 * Lo que se garantiza aquí es que este módulo NO puede provocar tráfico de red:
 * no importa Transformers, no tiene ninguna URL y sus funciones fallan de forma
 * controlada para que la capa superior siga usando el motor local.
 */

import { describe, expect, it } from 'vitest';
import { embedTexts, isNeuralReady, preloadModel, resetNeural, NEURAL_DISABLED_MESSAGE } from './neural.offline';

describe('motor neuronal deshabilitado (build offline)', () => {
  it('nunca se declara listo', () => {
    expect(isNeuralReady()).toBe(false);
    resetNeural();
    expect(isNeuralReady()).toBe(false);
  });

  it('libera recursos sin lanzar, aunque nunca hubo modelo', () => {
    expect(() => resetNeural()).not.toThrow();
  });

  it('rechaza el cálculo de embeddings de forma controlada', async () => {
    await expect(embedTexts(['cliente'])).rejects.toThrow(NEURAL_DISABLED_MESSAGE);
  });

  it('informa del motivo a quien escuche el progreso', async () => {
    const messages: string[] = [];
    await embedTexts(['cliente'], (progress) => messages.push(progress.message)).catch(() => undefined);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(NEURAL_DISABLED_MESSAGE);
  });

  it('rechaza el precalentamiento del modelo', async () => {
    await expect(preloadModel()).rejects.toThrow(NEURAL_DISABLED_MESSAGE);
  });

  it('no devuelve arrays vacíos silenciosos: el fallo es explícito', async () => {
    // Un fallo silencioso haría creer que el motor funciona pero sin resultados.
    await expect(embedTexts(['cliente', 'pedido'])).rejects.toBeInstanceOf(Error);
  });
});
