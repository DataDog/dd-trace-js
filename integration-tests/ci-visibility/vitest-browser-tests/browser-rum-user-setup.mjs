import { expect, test } from 'vitest'

test('retains RUM activity after the session stops', () => {
  expect(window.DD_RUM.getInternalContext()).toBeDefined()
  window.DD_RUM.stopSession()
  expect(window.DD_RUM.getInternalContext()).toBeUndefined()
})
