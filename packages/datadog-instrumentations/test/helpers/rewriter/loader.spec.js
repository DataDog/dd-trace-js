'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const GRAPHQL_TARGET = '/app/node_modules/graphql/execution/execute.js'
const LANGCHAIN_TARGET = '/app/node_modules/@langchain/core/dist/language_models/chat_models.cjs'
const NON_TARGET = '/app/node_modules/graphql/version.js'

describe('rewriter CommonJS loader', () => {
  afterEach(() => {
    delete process.versions.bun
  })

  function loadLoader () {
    const compile = sinon.spy()
    const compileJs = sinon.spy()
    const compileJson = sinon.spy()
    const Module = {
      prototype: { _compile: compile },
      _extensions: { '.js': compileJs, '.json': compileJson },
    }

    proxyquire('../../../src/helpers/rewriter/loader.js', { module: Module })

    return { Module, compile, compileJs, compileJson }
  }

  it('should wrap Module.prototype._compile without touching extensions outside Bun', () => {
    const { Module, compile, compileJs, compileJson } = loadLoader()

    assert.notStrictEqual(Module.prototype._compile, compile)
    assert.deepStrictEqual(Module._extensions, { '.js': compileJs, '.json': compileJson })
  })

  describe('on Bun', () => {
    function loadBunLoader () {
      Object.defineProperty(process.versions, 'bun', { value: '1.4.4', configurable: true, enumerable: true })

      return loadLoader()
    }

    for (const [extension, filename] of [['.js', GRAPHQL_TARGET], ['.cjs', LANGCHAIN_TARGET]]) {
      it(`should compile ${extension} rewrite targets through Module.prototype._compile`, () => {
        const { Module, compileJs } = loadBunLoader()
        const module = {}

        Module._extensions[extension].call('context', module, filename)

        assert.strictEqual(module._compile, Module.prototype._compile)
        sinon.assert.calledOnceWithExactly(compileJs, module, filename)
        assert.strictEqual(compileJs.firstCall.thisValue, 'context')
      })
    }

    it('should leave modules that are not rewrite targets to the native compiler', () => {
      const { Module, compileJs } = loadBunLoader()
      const module = {}

      Module._extensions['.js'](module, NON_TARGET)
      Module._extensions['.cjs'](module, NON_TARGET.replace(/\.js$/, '.cjs'))

      assert.ok(!Object.hasOwn(module, '_compile'))
      sinon.assert.calledTwice(compileJs)
    })

    it('should match Windows paths of rewrite targets', () => {
      const { Module } = loadBunLoader()
      const module = {}

      Module._extensions['.js'](module, 'C:\\app\\node_modules\\graphql\\execution\\execute.js')

      assert.strictEqual(module._compile, Module.prototype._compile)
    })

    it('should delegate to an existing .cjs handler', () => {
      Object.defineProperty(process.versions, 'bun', { value: '1.4.4', configurable: true, enumerable: true })
      const compileJs = sinon.spy()
      const compileCjs = sinon.spy()
      const Module = {
        prototype: { _compile: sinon.spy() },
        _extensions: { '.js': compileJs, '.cjs': compileCjs },
      }

      proxyquire('../../../src/helpers/rewriter/loader.js', { module: Module })
      const module = {}
      Module._extensions['.cjs'](module, LANGCHAIN_TARGET)

      sinon.assert.calledOnceWithExactly(compileCjs, module, LANGCHAIN_TARGET)
      sinon.assert.notCalled(compileJs)
      assert.strictEqual(module._compile, Module.prototype._compile)
    })

    it('should leave other extensions untouched', () => {
      const { Module, compileJson } = loadBunLoader()

      assert.deepStrictEqual(Object.keys(Module._extensions), ['.js', '.json', '.cjs'])
      assert.strictEqual(Module._extensions['.json'], compileJson)
    })
  })
})
