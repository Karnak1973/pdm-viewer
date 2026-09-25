import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, 'VITE_')

  // Fuente única de verdad: la misma variable decide el flag de la interfaz
  // (en buildConfig.ts) y qué implementación del motor de embeddings se
  // empaqueta. Así no pueden desincronizarse.
  const externalAiEnabled = env.VITE_ENABLE_EXTERNAL_AI !== 'false'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        // En el build offline, `@neural` apunta al stub sin red, de modo que
        // Transformers y el runtime ONNX quedan fuera del grafo de módulos.
        '@neural': resolve(
          rootDir,
          externalAiEnabled ? 'src/ml/neural.ts' : 'src/ml/neural.offline.ts',
        ),
      },
    },
  }
})
