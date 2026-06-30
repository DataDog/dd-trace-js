import assert from 'node:assert/strict'

import { describe, it } from '@jest/globals'

import { esmAggregate } from '../esm/entry.mjs'

describe('delta esm suite', () => {
  it('touches static esm, dynamic esm, and cjs imported from esm', async () => {
    const lazyModule = await import('../esm/lazy-esm.mjs')

    assert.strictEqual(esmAggregate('delta'), 'delta:esm:6:6')
    assert.strictEqual(lazyModule.lazyEsm('delta'), 'lazy-esm:delta')
  })
})
