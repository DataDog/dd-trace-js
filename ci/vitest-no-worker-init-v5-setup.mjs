import { test, TestRunner } from 'vitest'

const { captureDeclarations } = globalThis.process?.env?.DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE === '1'
  ? await import('./vitest-no-worker-init-annotations.mjs')
  : await import('virtual:dd-vitest-test-declaration-annotations')
captureDeclarations(test, TestRunner.getCurrentSuite)

globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')] = () => import('vitest/browser')
globalThis[Symbol.for('dd-trace.vitest.skip-task')] = skip => skip('Skipped by Datadog Test Optimization')

await import('./vitest-no-worker-init-setup.mjs')
