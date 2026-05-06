'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')

const {
  truncateSpan,
  MAX_RESOURCE_NAME_LENGTH,
} = require('../../src/encode/tags-processors')

describe('tags-processors', () => {
  describe('truncateSpan', () => {
    it('leaves a resource at the limit untouched and truncates one past it', () => {
      const accepted = 'a'.repeat(MAX_RESOURCE_NAME_LENGTH)
      const overlong = `${'a'.repeat(MAX_RESOURCE_NAME_LENGTH)}X`

      assert.strictEqual(truncateSpan({ resource: accepted }).resource, accepted)
      assert.strictEqual(
        truncateSpan({ resource: overlong }).resource,
        `${overlong.slice(0, MAX_RESOURCE_NAME_LENGTH)}...`
      )
    })
  })
})
