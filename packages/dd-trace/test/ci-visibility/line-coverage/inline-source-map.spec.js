'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { getInlineSourceMap } = require('../../../src/ci-visibility/line-coverage/inline-source-map')

const MAP = JSON.stringify({ version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA' })
const ENCODED = Buffer.from(MAP).toString('base64')

describe('line coverage inline source map', () => {
  it('reads a map appended as a base64 data URL', () => {
    const code = `export const a = 1\n//# sourceMappingURL=data:application/json;base64,${ENCODED}\n`
    assert.equal(getInlineSourceMap(code), MAP)
  })

  it('reads a map whose data URL names a charset', () => {
    const code = `a()\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${ENCODED}\n`
    assert.equal(getInlineSourceMap(code), MAP)
  })

  it('ignores what follows the map', () => {
    const code = `a()\n//# sourceMappingURL=data:application/json;base64,${ENCODED}\n//# vitestCache=W3siZmlsZSI6IjEi`
    assert.equal(getInlineSourceMap(code), MAP)
  })

  it('reads the last map when the code embeds an earlier one', () => {
    const other = Buffer.from('{"version":3}').toString('base64')
    const code = `//# sourceMappingURL=data:application/json;base64,${other}\n` +
      `//# sourceMappingURL=data:application/json;base64,${ENCODED}\n`
    assert.equal(getInlineSourceMap(code), MAP)
  })

  it('returns nothing without a map or with a map that is not inline', () => {
    assert.equal(getInlineSourceMap('export const a = 1\n'), undefined)
    assert.equal(getInlineSourceMap('a()\n//# sourceMappingURL=a.js.map\n'), undefined)
    assert.equal(getInlineSourceMap('a()\n//# sourceMappingURL=data:application/json;base64,\n'), undefined)
  })
})
