import { describe, test } from 'vitest'

describe('attempt to fix skip tests', () => {
  test.skip('can statically skip', () => {})

  test('can programmatically skip', (context) => {
    context.skip()
  })
})
