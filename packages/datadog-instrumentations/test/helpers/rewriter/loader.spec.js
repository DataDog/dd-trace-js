'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
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

  describe('on Bun', () => {
    let rewrite
    let getRewriteTarget

    beforeEach(() => {
      Object.defineProperty(process.versions, 'bun', { value: '1.3.0', configurable: true })
      rewrite = sinon.stub().returns('rewritten')
      getRewriteTarget = sinon.stub().callsFake(filename => filename.includes('/node_modules/target/') ? {} : undefined)
    })

    afterEach(() => {
      delete process.versions.bun
    })

    function load (extensions) {
      const Module = { prototype: { _compile () {} }, _extensions: extensions }

      proxyquire('../../../src/helpers/rewriter/loader.js', {
        module: Module,
        './': { rewrite, '@noCallThru': true },
        './targets': { getRewriteTarget, '@noCallThru': true },
      })

      return Module
    }

    function nativeCompile (module, filename) {
      module._compile('original', filename, 'commonjs')
    }

    it('should rewrite targeted files through the module\'s current _compile', () => {
      const Module = load({ '.js': nativeCompile })
      const compile = sinon.spy()
      const module = { _compile: compile }
      const filename = 'C:\\app\\node_modules\\target\\index.js'

      Module._extensions['.js'](module, filename)

      sinon.assert.calledOnceWithExactly(getRewriteTarget, 'C:/app/node_modules/target/index.js')
      sinon.assert.calledOnceWithExactly(rewrite, 'original', filename, 'commonjs')
      sinon.assert.calledOnceWithExactly(compile, 'rewritten', filename, 'commonjs')
    })

    it('should leave files that are not rewrite targets untouched', () => {
      const Module = load({ '.js': nativeCompile })
      const compile = sinon.spy()
      const module = { _compile: compile }

      Module._extensions['.js'](module, '/app/node_modules/other/index.js')

      assert.strictEqual(module._compile, compile)
      sinon.assert.notCalled(rewrite)
      sinon.assert.calledOnceWithExactly(compile, 'original', '/app/node_modules/other/index.js', 'commonjs')
    })

    it('should register a .cjs handler that falls back to the .js handler', () => {
      const compileJs = sinon.spy(nativeCompile)
      const Module = load({ '.js': compileJs })
      const compile = sinon.spy()

      Module._extensions['.cjs']({ _compile: compile }, '/app/node_modules/target/index.cjs')

      sinon.assert.calledOnce(compileJs)
      sinon.assert.calledOnceWithExactly(compile, 'rewritten', '/app/node_modules/target/index.cjs', 'commonjs')
    })

    it('should keep an existing .cjs handler', () => {
      const compileJs = sinon.spy(nativeCompile)
      const compileCjs = sinon.spy(nativeCompile)
      const Module = load({ '.js': compileJs, '.cjs': compileCjs })

      Module._extensions['.cjs']({ _compile: sinon.spy() }, '/app/node_modules/target/index.cjs')

      sinon.assert.calledOnce(compileCjs)
      sinon.assert.notCalled(compileJs)
    })
  })
})
