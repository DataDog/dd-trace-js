globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')] = () => import('vitest/browser')

await import('./vitest-no-worker-init-setup.mjs')
