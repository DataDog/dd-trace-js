'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const sinon = require('sinon')

require('../src/playwright')

const PLAYWRIGHT_HOOKS = globalThis[Symbol.for('_ddtrace_instrumentations')]['playwright-core']
const PAGE_HOOK = PLAYWRIGHT_HOOKS.find(entry => entry.file === 'lib/client/page.js').hook

describe('packages/datadog-instrumentations/src/playwright.js', () => {
  it('owns rejected RUM correlation cookie promises', async () => {
    const addCookies = sinon.stub().rejects(new Error('cookie rejected'))
    const browserContext = {
      addCookies,
      browser: () => ({
        version: () => 'browser-version',
      }),
    }

    class Page {
      async goto () {
        return 'response'
      }

      async evaluate () {
        return {
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        }
      }

      context () {
        return browserContext
      }

      url () {
        return 'https://example.com/test'
      }
    }

    const pageGotoCh = channel('ci:playwright:test:page-goto')
    let pageGotoEvent
    const onPageGoto = (event) => {
      pageGotoEvent = event
      event.onDone?.('test-execution-id')
    }
    pageGotoCh.subscribe(onPageGoto)

    try {
      const { Page: WrappedPage } = PAGE_HOOK({ Page })
      const response = await new WrappedPage().goto()

      assert.strictEqual(response, 'response')
      assert.strictEqual(pageGotoEvent.browserVersion, 'browser-version')
      assert.strictEqual(pageGotoEvent.page, undefined)
      sinon.assert.calledOnceWithExactly(addCookies, [{
        name: 'datadog-ci-visibility-test-execution-id',
        value: 'test-execution-id',
        domain: 'example.com',
        path: '/',
      }])
    } finally {
      pageGotoCh.unsubscribe(onPageGoto)
    }
  })
})
