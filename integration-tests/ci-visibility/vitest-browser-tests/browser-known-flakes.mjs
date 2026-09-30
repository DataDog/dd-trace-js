import { expect, inject, test } from 'vitest'

test('receives only selected flaky suites', () => {
  const { flakyTests } = inject('_ddVitestWorkerSetup')
  if (flakyTests !== undefined) {
    expect(Object.keys(flakyTests)).toEqual(['ci-visibility/vitest-browser-tests/browser-known-flakes.mjs'])
  }
})

test('listed failure', () => { throw new Error('listed failure') })
test('unlisted failure', () => { throw new Error('unlisted failure') })
