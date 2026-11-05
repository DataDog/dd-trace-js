import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { captureDeclarations } from './vitest-no-worker-init-annotations.mjs'

// Prefer the project's Vitest, with a fallback for tooling installed below the configured test root.
const packageJsonPath = createRequire(import.meta.url).resolve('vitest/package.json', {
  paths: [globalThis.__vitest_worker__.config.root, path.dirname(fileURLToPath(import.meta.url))],
})
const vitestRequire = createRequire(packageJsonPath)
// require.resolve('vitest') selects its CommonJS entrypoint, which rejects require().
const { module: entrypoint } = vitestRequire(packageJsonPath)
const vitest = await import(new URL(entrypoint, pathToFileURL(packageJsonPath)).href)
const vitestRunner = vitest.TestRunner || await import(pathToFileURL(vitestRequire.resolve('vitest/suite')).href)

globalThis[Symbol.for('dd-trace.vitest.api')] = vitest
globalThis[Symbol.for('dd-trace.vitest.set-fn')] = vitestRunner.setTestFn || vitestRunner.setFn
globalThis[Symbol.for('dd-trace.vitest.skip-task')] = skip => skip('Skipped by Datadog Test Optimization')
captureDeclarations(vitest.test, vitestRunner.getCurrentSuite)

await import('./vitest-no-worker-init-setup.mjs')
