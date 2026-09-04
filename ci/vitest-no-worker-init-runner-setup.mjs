import { setFn } from '@vitest/runner'

globalThis[Symbol.for('dd-trace.vitest.set-fn')] = setFn
globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')] = () => import('@vitest/browser/context')

await import('./vitest-no-worker-init-setup.mjs')
