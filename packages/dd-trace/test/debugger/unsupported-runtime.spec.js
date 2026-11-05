'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../setup/mocha')

const { getUnsupportedRuntime } = require('../../src/debugger/unsupported-runtime')

describe('debugger/unsupported-runtime', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('should support Node.js', () => {
    assert.strictEqual(getUnsupportedRuntime(), undefined)
  })

  it('should not support Bun', () => {
    sinon.stub(process, 'versions').value({ ...process.versions, bun: '1.4.3' })

    assert.strictEqual(getUnsupportedRuntime(), 'Bun')
  })

  it('should not support Deno, even though it reports a Node.js version', () => {
    sinon.stub(process, 'versions').value({ ...process.versions, node: '26.0.0', deno: '2.9.6' })

    assert.strictEqual(getUnsupportedRuntime(), 'Deno')
  })
})
