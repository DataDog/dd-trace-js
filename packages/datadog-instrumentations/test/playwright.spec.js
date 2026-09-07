'use strict'

const Module = require('node:module')
const assert = require('node:assert/strict')

const { tracingChannel } = require('dc-polyfill')

const { create } = require('../../../vendor/dist/@apm-js-collab/code-transformer')
const instrumentations = require('../src/helpers/rewriter/instrumentations/playwright')
const { waitForAsyncEnd } = require('../src/helpers/rewriter/transforms')

describe('playwright instrumentation', () => {
  const channel = tracingChannel('orchestrion:playwright-core:Page_goto')
  let subscribers

  afterEach(() => {
    if (subscribers) channel.unsubscribe(subscribers)
  })

  it('rewrites Page.goto independently of the generated bundle binding name', async () => {
    const source = `
      let Page3
      Page3 = class _Page {
        async goto (url, options) {
          return await this._mainFrame.goto(url, options)
        }
      }
      module.exports = Page3
    `
    const configs = instrumentations.filter(({ module }) => module.name === 'playwright-core')
    const matcher = create(configs, require.resolve('dc-polyfill'))
    matcher.addTransform('waitForAsyncEnd', waitForAsyncEnd)
    const transformer = matcher.getTransformer('playwright-core', '1.63.0', 'lib/coreBundle.js')
    const { code } = transformer.transform(source, 'cjs')
    const filename = require.resolve('./playwright.spec.js')
    const mod = new Module(filename, module.parent)

    mod.filename = filename
    mod.paths = Module._nodeModulePaths(__dirname)
    mod._compile(code, filename)

    let callbackInvoked = false
    subscribers = {
      asyncEnd (ctx) {
        ctx.resolveCallback = onDone => {
          callbackInvoked = true
          onDone()
        }
      },
    }
    channel.subscribe(subscribers)

    const Page = mod.exports
    const page = new Page()
    page._mainFrame = {
      async goto () {
        return 'response'
      },
    }

    assert.strictEqual(await page.goto('https://example.com'), 'response')
    assert.strictEqual(callbackInvoked, true)
  })
})
