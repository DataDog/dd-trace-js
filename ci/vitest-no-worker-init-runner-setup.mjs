import * as vitest from 'vitest'

const vitestRunner = vitest.TestRunner || await import('vitest/suite')
globalThis[Symbol.for('dd-trace.vitest.set-fn')] = vitestRunner.setTestFn || vitestRunner.setFn
const { captureDeclarations } = globalThis.process?.env?.DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE === '1'
  ? await import('./vitest-no-worker-init-annotations.mjs')
  : await import('virtual:dd-vitest-test-declaration-annotations')
captureDeclarations(vitest.test, vitestRunner.getCurrentSuite)
globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')] = () => import('@vitest/browser/context')

await import('./vitest-no-worker-init-setup.mjs')
