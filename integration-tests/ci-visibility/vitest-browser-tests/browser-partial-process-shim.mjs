import { expect, test } from 'vitest'

test('runs with a partial process shim', () => {
  expect(globalThis.process?.versions?.node).toBeDefined()
  expect(globalThis.process?.uptime).toBeUndefined()
})
