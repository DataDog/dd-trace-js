import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { captureDeclarations } from './vitest-no-worker-init-annotations.mjs'

// Vitest's resolver selects the running installation even when config.root contains another copy.
const worker = globalThis.__vitest_worker__
// Vitest 3 uses Vite Node's resolveId RPC; Vitest 4+ uses Vite's named environments.
const { id } = worker.moduleCache
  ? await worker.rpc.resolveId('vitest', undefined, 'ssr')
  : await worker.rpc.resolve('vitest', undefined, '__vitest__')
const vitestUrl = id.startsWith('file:') ? id : pathToFileURL(id).href
const vitestRequire = createRequire(vitestUrl)
const vitest = await import(vitestUrl)
const vitestRunner = vitest.TestRunner || await import(pathToFileURL(vitestRequire.resolve('vitest/suite')).href)

globalThis[Symbol.for('dd-trace.vitest.api')] = vitest
globalThis[Symbol.for('dd-trace.vitest.set-fn')] = vitestRunner.setTestFn || vitestRunner.setFn
globalThis[Symbol.for('dd-trace.vitest.skip-task')] = skip => skip('Skipped by Datadog Test Optimization')
captureDeclarations(vitest.test, vitestRunner.getCurrentSuite)

await import('./vitest-no-worker-init-setup.mjs')
