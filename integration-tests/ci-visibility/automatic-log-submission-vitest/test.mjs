import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { describe, it } from 'vitest'

const require = createRequire(import.meta.url)
const logger = require('../automatic-log-submission/logger')
const sum = require('../automatic-log-submission/sum')

describe('test', () => {
  it('should return true', () => {
    logger.info('Hello simple log!')

    assert.strictEqual(sum(1, 2), 3)
  })
})
