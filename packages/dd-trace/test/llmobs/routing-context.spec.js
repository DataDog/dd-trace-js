'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const { withRoutingContext, getCurrentRouting } = require('../../src/llmobs/routing-context')

describe('routing-context', () => {
  describe('withRoutingContext', () => {
    it('throws if ddApiKey is not provided', () => {
      assert.throws(() => {
        withRoutingContext({}, () => {})
      }, /ddApiKey is required/)
    })

    it('throws if options is null', () => {
      assert.throws(() => {
        withRoutingContext(null, () => {})
      }, /ddApiKey is required/)
    })

    it('throws if ddApiKey is empty string', () => {
      assert.throws(() => {
        withRoutingContext({ ddApiKey: '' }, () => {})
      }, /ddApiKey is required/)
    })

    it('executes the function with routing context', () => {
      let capturedRouting
      withRoutingContext({ ddApiKey: 'test-key', ddSite: 'test-site' }, () => {
        capturedRouting = getCurrentRouting()
      })

      assert.strictEqual(capturedRouting.apiKey, 'test-key')
      assert.strictEqual(capturedRouting.site, 'test-site')
    })

    it('supports async functions', async () => {
      let capturedRouting
      await withRoutingContext({ ddApiKey: 'async-key' }, async () => {
        await Promise.resolve()
        capturedRouting = getCurrentRouting()
      })

      assert.strictEqual(capturedRouting.apiKey, 'async-key')
    })

    it('returns the function result', () => {
      const result = withRoutingContext({ ddApiKey: 'key' }, () => 'result')
      assert.strictEqual(result, 'result')
    })

    it('returns the promise result for async functions', async () => {
      const result = await withRoutingContext({ ddApiKey: 'key' }, async () => 'async-result')
      assert.strictEqual(result, 'async-result')
    })

    it('propagates errors from the function', () => {
      assert.throws(() => {
        withRoutingContext({ ddApiKey: 'key' }, () => {
          throw new Error('test error')
        })
      }, /test error/)
    })

    it('handles optional ddSite', () => {
      let capturedRouting
      withRoutingContext({ ddApiKey: 'key-only' }, () => {
        capturedRouting = getCurrentRouting()
      })

      assert.strictEqual(capturedRouting.apiKey, 'key-only')
      assert.strictEqual(capturedRouting.site, undefined)
    })
  })

  describe('getCurrentRouting', () => {
    it('returns null when not in a routing context', () => {
      const routing = getCurrentRouting()

      assert.strictEqual(routing, null)
    })

    it('returns context values when in a routing context', () => {
      let routing
      withRoutingContext({ ddApiKey: 'context-key', ddSite: 'context-site' }, () => {
        routing = getCurrentRouting()
      })

      assert.strictEqual(routing.apiKey, 'context-key')
      assert.strictEqual(routing.site, 'context-site')
    })

    it('preserves context across async operations', async () => {
      let routing
      await withRoutingContext({ ddApiKey: 'async-key', ddSite: 'async-site' }, async () => {
        await new Promise(resolve => setImmediate(resolve))
        routing = getCurrentRouting()
      })

      assert.strictEqual(routing.apiKey, 'async-key')
      assert.strictEqual(routing.site, 'async-site')
    })
  })

  describe('nested contexts', () => {
    it('allows nested routing contexts where inner overrides outer', () => {
      let outerRouting, innerRouting, afterInnerRouting

      withRoutingContext({ ddApiKey: 'outer-key', ddSite: 'outer-site' }, () => {
        outerRouting = getCurrentRouting()

        withRoutingContext({ ddApiKey: 'inner-key', ddSite: 'inner-site' }, () => {
          innerRouting = getCurrentRouting()
        })

        afterInnerRouting = getCurrentRouting()
      })

      assert.strictEqual(outerRouting.apiKey, 'outer-key')
      assert.strictEqual(outerRouting.site, 'outer-site')
      assert.strictEqual(innerRouting.apiKey, 'inner-key')
      assert.strictEqual(innerRouting.site, 'inner-site')
      assert.strictEqual(afterInnerRouting.apiKey, 'outer-key')
      assert.strictEqual(afterInnerRouting.site, 'outer-site')
    })
  })

  describe('concurrent contexts', () => {
    it('isolates routing between concurrent contexts', async () => {
      const results = []

      await Promise.all([
        withRoutingContext({ ddApiKey: 'key-a', ddSite: 'site-a' }, async () => {
          await new Promise(resolve => setTimeout(resolve, 10))
          results.push({ context: 'A', routing: getCurrentRouting() })
        }),
        withRoutingContext({ ddApiKey: 'key-b', ddSite: 'site-b' }, async () => {
          await new Promise(resolve => setTimeout(resolve, 5))
          results.push({ context: 'B', routing: getCurrentRouting() })
        })
      ])

      const resultA = results.find(r => r.context === 'A')
      const resultB = results.find(r => r.context === 'B')

      assert.strictEqual(resultA.routing.apiKey, 'key-a')
      assert.strictEqual(resultA.routing.site, 'site-a')
      assert.strictEqual(resultB.routing.apiKey, 'key-b')
      assert.strictEqual(resultB.routing.site, 'site-b')
    })
  })
})
