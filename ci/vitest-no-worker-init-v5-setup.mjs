import { test, TestRunner } from 'vitest'

import { captureDeclarations } from './vitest-no-worker-init-annotations.mjs'

captureDeclarations(test, TestRunner.getCurrentSuite)

globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')] = () => import('vitest/browser')
globalThis[Symbol.for('dd-trace.vitest.skip-task')] = skip => skip('Skipped by Datadog Test Optimization')

// Preserve Vitest's cache-busting query so each spec registers its own execution hooks.
// eslint-disable-next-line jsdoc/no-bad-blocks
await import(/* @vite-ignore */ `./vitest-no-worker-init-setup.mjs${new URL(import.meta.url).search}`)
