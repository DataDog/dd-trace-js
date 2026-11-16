import * as vitest from 'vitest'

import { captureDeclarations } from './vitest-no-worker-init-annotations.mjs'

const vitestRunner = vitest.TestRunner || await import('vitest/suite')
globalThis[Symbol.for('dd-trace.vitest.set-fn')] = vitestRunner.setTestFn || vitestRunner.setFn
captureDeclarations(vitest.test, vitestRunner.getCurrentSuite)
globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')] = () => import('@vitest/browser/context')

// Preserve Vitest's cache-busting query so each spec registers its own execution hooks.
// eslint-disable-next-line jsdoc/no-bad-blocks
await import(/* @vite-ignore */ `./vitest-no-worker-init-setup.mjs${new URL(import.meta.url).search}`)
