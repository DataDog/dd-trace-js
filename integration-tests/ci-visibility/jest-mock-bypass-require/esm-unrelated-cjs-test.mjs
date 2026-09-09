import assert from 'node:assert/strict'

import { describe, it } from '@jest/globals'
import mappedLogger from './mapped-logger.js'

describe('unrelated CommonJS ESM import', () => {
  it('loads through Jest', () => {
    assert.deepStrictEqual(mappedLogger, { mapped: true })
  })
})
