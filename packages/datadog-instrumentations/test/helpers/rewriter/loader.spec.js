'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('rewriter CommonJS loader', () => {
  it('should wrap Module.prototype._compile without touching extensions outside Bun', () => {
    const compile = sinon.spy()
    const compileJs = sinon.spy()
    const compileJson = sinon.spy()
    const Module = {
      prototype: { _compile: compile },
      _extensions: { '.js': compileJs, '.json': compileJson },
    }

    proxyquire('../../../src/helpers/rewriter/loader.js', { module: Module })

    assert.notStrictEqual(Module.prototype._compile, compile)
    assert.deepStrictEqual(Module._extensions, { '.js': compileJs, '.json': compileJson })
  })
})
