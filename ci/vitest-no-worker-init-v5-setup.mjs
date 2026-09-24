globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')] = () => import('vitest/browser')
globalThis[Symbol.for('dd-trace.vitest.skip-task')] = skip => skip('Skipped by Datadog Test Optimization')

await import('./vitest-no-worker-init-setup.mjs')
