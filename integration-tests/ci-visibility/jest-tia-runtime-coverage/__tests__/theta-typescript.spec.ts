import assert from 'node:assert/strict'

import { describe, it } from '@jest/globals'

import { buildTypedLabel } from '../ts/ts-entry'

describe('theta typescript suite', () => {
  it('touches transformed typescript imports and type-only imports', () => {
    assert.strictEqual(buildTypedLabel({ name: 'theta', count: 4 }), 'theta:typed:10')
  })
})
