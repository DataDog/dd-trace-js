import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { captureDeclarations } from './vitest-no-worker-init-annotations.mjs'

// dd-trace can live outside the project, including in the GitHub Action's separate installation.
const projectRequire = createRequire(path.join(globalThis.__vitest_worker__.config.root, 'package.json'))
const packageJsonPath = projectRequire.resolve('vitest/package.json')
// require.resolve('vitest') selects its CommonJS entrypoint, which rejects require().
const { module: entrypoint } = projectRequire(packageJsonPath)
const vitest = await import(new URL(entrypoint, pathToFileURL(packageJsonPath)).href)
const vitestRunner = vitest.TestRunner || await import(pathToFileURL(projectRequire.resolve('vitest/suite')).href)

globalThis[Symbol.for('dd-trace.vitest.api')] = vitest
globalThis[Symbol.for('dd-trace.vitest.set-fn')] = vitestRunner.setTestFn || vitestRunner.setFn
globalThis[Symbol.for('dd-trace.vitest.skip-task')] = skip => skip('Skipped by Datadog Test Optimization')
captureDeclarations(vitest.test, vitestRunner.getCurrentSuite)

await import('./vitest-no-worker-init-setup.mjs')
