import assert from 'node:assert/strict'

import { product, sum } from './arithmetic.mjs'

describe('es module arithmetic', () => {
  it('adds', () => {
    assert.strictEqual(sum(1, 2), 3)
  })

  it('multiplies', () => {
    assert.strictEqual(product(2, 3), 6)
  })
})
