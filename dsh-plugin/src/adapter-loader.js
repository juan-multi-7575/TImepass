import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PROJECT_ROOT } from './config.js'

/**
 * Locate and load the timepass `GeminiAdapter` this plugin drives.
 *
 * The harness process usually runs under tsx (a source launch, or `dsh` from a
 * checkout), so the adapter is imported from the project source and is always
 * current with the working tree. A packaged runtime without tsx falls back to
 * the compiled `dist/` output, which the project's build produces.
 * @module dsh-timepass-gemini/adapter-loader
 */

/** Absolute path of this plugin's `src/` directory. */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Import targets in preference order, each with the reason it is tried. */
const CANDIDATES = [
  { file: path.resolve(HERE, '..', '..', 'src', 'index.ts'), why: 'project source (needs a tsx-capable runtime)' },
  { file: path.resolve(HERE, '..', '..', 'dist', 'index.js'), why: 'compiled output' },
]

/** Memoized successful load, so repeated tool calls import the module once. */
let cached = null

/**
 * Import the adapter class.
 *
 * A success is cached for the process; a failure is not, so a later call retries
 * after the operator fixes the build or the runtime.
 *
 * @returns {Promise<{ GeminiAdapter: new (options?: Record<string, unknown>) => any, from: string }>} The adapter class and the module it came from.
 * @throws {Error} When no candidate module could be loaded, listing every attempt.
 */
export async function loadGeminiAdapter() {
  if (cached) return cached

  const failures = []
  for (const candidate of CANDIDATES) {
    try {
      const module = await import(pathToFileURL(candidate.file).href)
      if (typeof module?.GeminiAdapter !== 'function') {
        failures.push(candidate.file + ' (' + candidate.why + '): module has no GeminiAdapter export')
        continue
      }
      cached = { GeminiAdapter: module.GeminiAdapter, from: candidate.file }
      return cached
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failures.push(candidate.file + ' (' + candidate.why + '): ' + detail)
    }
  }

  throw new Error([
    'timepass-gemini: could not load the timepass GeminiAdapter from ' + PROJECT_ROOT + '.',
    'Tried:',
    ...failures.map(line => '  - ' + line),
    "Run 'npm run build' in the timepass project, or launch the harness with tsx.",
  ].join('\n'))
}
