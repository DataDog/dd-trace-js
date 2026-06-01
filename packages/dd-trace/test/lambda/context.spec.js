'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const { extractContext } = require('../../src/lambda/context')

describe('context', () => {
  describe('extractContext', () => {
    const assertExtractContext = (args, doesExtract) => {
      it(`properly extracts context object from args length ${args.length}`, () => {
        const ctx = extractContext(args)
        if (doesExtract) {
          assert.strictEqual(typeof ctx.getRemainingTimeInMillis, 'function')
          assert.strictEqual(ctx.getRemainingTimeInMillis(), 100)
        } else {
          assert.strictEqual(ctx, null)
        }
      })
    }

    const contexts = [
      [null, false],
      [[], false],
      [{}, false],
      [{ getRemainingTimeInMillis: null }, false],
      [{ getRemainingTimeInMillis: undefined }, false],
      [{ getRemainingTimeInMillis: 'not a function' }, false],
      [{ getRemainingTimeInMillis: () => 100 }, true],
    ]

    assertExtractContext([], false)
    assertExtractContext([{}], false)
    contexts.forEach(([context, doesExtract], index) => {
      describe(`using context case ${index + 1}`, () => {
        assertExtractContext([{}, context], doesExtract)
        assertExtractContext([{}, {}, context], doesExtract)
        assertExtractContext([{}, {}, {}, context], false)
      })
    })
  })
})
