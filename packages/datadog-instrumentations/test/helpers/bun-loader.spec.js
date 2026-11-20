'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const loaderPath = require.resolve('../../src/helpers/bun-loader')

describe('helpers/bun-loader', () => {
  let bun
  let register

  beforeEach(() => {
    delete require.cache[loaderPath]
    ;({ register } = require(loaderPath))
    bun = { plugin: sinon.spy() }
    globalThis.Bun = bun
  })

  afterEach(() => {
    delete globalThis.Bun
    sinon.restore()
  })

  it('does not register a plugin outside of Bun', () => {
    register()

    sinon.assert.notCalled(bun.plugin)
  })

  // Registration loads the ES module loaders through `require()`, which Bun always supports.
  // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Feature detection skips unsupported runtimes.
  const describeOnBun = process.features.require_module ? describe : describe.skip

  describeOnBun('on Bun', () => {
    let filter
    let onLoad

    beforeEach(() => {
      sinon.stub(process, 'versions').value({ ...process.versions, bun: '1.4.4' })

      register()

      sinon.assert.calledOnce(bun.plugin)
      const [plugin] = bun.plugin.firstCall.args
      assert.equal(plugin.name, 'dd-trace')

      const build = { onLoad: sinon.spy() }
      plugin.setup(build)
      sinon.assert.calledOnce(build.onLoad)
      ;[{ filter }, onLoad] = build.onLoad.firstCall.args
    })

    it('registers its plugin only once', () => {
      register()

      sinon.assert.calledOnce(bun.plugin)
      assert.equal(typeof onLoad, 'function')
    })

    it('loads files of packages with require hooks or Orchestrion rewrites', () => {
      assert.match('/app/node_modules/pino/pino.js', filter)
      assert.match('/app/node_modules/openai/index.mjs', filter)
      assert.match('/app/node_modules/openai/index.mjs?dd-trace=original', filter)
      assert.match('/app/node_modules/ai/dist/index.cjs', filter)
      assert.match(String.raw`C:\app\node_modules\@langchain\core\dist\index.js`, filter)
    })

    it('does not load files of other packages', () => {
      assert.doesNotMatch('/app/node_modules/left-pad/index.js', filter)
      assert.doesNotMatch('/app/node_modules/pinot/index.js', filter)
      assert.doesNotMatch('/app/node_modules/pino/node_modules/left-pad/index.js', filter)
      assert.doesNotMatch('/app/node_modules/pino/package.json', filter)
      assert.doesNotMatch('/app/src/pino.js', filter)
    })
  })
})
