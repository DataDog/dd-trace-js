import * as vitest from 'vitest'

import { captureDeclarations } from './vitest-no-worker-init-annotations.mjs'

const vitestRunner = vitest.TestRunner || await import('vitest/suite')
globalThis[Symbol.for('dd-trace.vitest.set-fn')] = vitestRunner.setTestFn || vitestRunner.setFn
captureDeclarations(vitest.test, vitestRunner.getCurrentSuite)
globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')] = () => import('@vitest/browser/context')

await import('./vitest-no-worker-init-setup.mjs')
