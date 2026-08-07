'use strict'

const assert = require('node:assert/strict')

const {
  makeProvidedContextBrowserSafe,
  parseProvidedContextValue,
} = require('../src/vitest-util')

describe('vitest utilities', () => {
  describe('browser-safe provided context', () => {
    it('leaves safe context unchanged', () => {
      const context = { knownTests: ['safe test'] }

      assert.strictEqual(makeProvidedContextBrowserSafe(context), context)
      assert.strictEqual(parseProvidedContextValue(context), context)
    })

    it('round trips context containing a closing script tag without exposing HTML markup', () => {
      const context = {
        knownTests: ['test containing </ScRiPt> and <markup>'],
      }

      const safeContext = makeProvidedContextBrowserSafe(context)

      assert.strictEqual(typeof safeContext, 'string')
      assert.ok(!safeContext.includes('<'))
      assert.deepStrictEqual(parseProvidedContextValue(safeContext), context)
    })

    it('rejects malformed serialized context', () => {
      assert.strictEqual(parseProvidedContextValue('{'), undefined)
    })
  })
})
