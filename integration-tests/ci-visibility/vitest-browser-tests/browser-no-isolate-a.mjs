import { expect, test } from 'vitest'

test('repeats a new browser test', () => {
  const setupImports = performance.getEntriesByType('resource')
    .filter(entry => entry.name.includes('/vitest-no-worker-init-setup.mjs'))
  expect(setupImports).toHaveLength(1)
})

test('attempts to fix a browser test', () => {
  expect(true).toBe(true)
})

test('does not execute a disabled browser test', () => {
  throw new Error('disabled browser test was executed')
})

test('quarantines a failing browser test', () => {
  expect(true).toBe(false)
})
