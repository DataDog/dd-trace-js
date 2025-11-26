/** Some comment */
/* eslint-disable jsdoc/valid-types */
/**
 * @datadog {"unskippable": true}
 */
/* Some other comment */
'use strict'

const assert = require('node:assert/strict')

describe('test-unskippable', () => {
  it('can report tests', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
