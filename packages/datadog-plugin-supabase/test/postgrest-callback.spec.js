'use strict'

const assert = require('node:assert/strict')

const SupabasePostgrestBuilderThenPlugin = require('../src/supabase-postgrest-js-postgrestbuilder-then')

function createPlugin () {
  const plugin = Object.create(SupabasePostgrestBuilderThenPlugin.prototype)
  plugin._tracer = { _service: 'test' }
  plugin.startSpan = (name, options, ctx) => {
    ctx.parentStore = {}
    ctx.currentStore = {}
  }
  return plugin
}

function createContext (onFulfilled, onRejected) {
  return {
    arguments: [onFulfilled, onRejected],
    self: {
      method: 'GET',
      schema: 'public',
      url: new URL('https://project.supabase.co/rest/v1/items'),
    },
  }
}

describe('PostgrestBuilder.then() callbacks', () => {
  it('preserves the fulfillment callback when tracing finalization throws', () => {
    const plugin = createPlugin()
    const ctx = createContext(result => result.data)
    plugin.finish = () => { throw new Error('tracing failure') }
    plugin.configure = enabled => { plugin.enabled = enabled }

    plugin.bindStart(ctx)

    assert.strictEqual(ctx.arguments[0]({ data: 'result' }), 'result')
    assert.strictEqual(plugin.enabled, false)
  })

  it('preserves the rejection callback when tracing error handling throws', () => {
    const plugin = createPlugin()
    const ctx = createContext(undefined, error => error.message)
    plugin.error = () => { throw new Error('tracing failure') }
    plugin.configure = enabled => { plugin.enabled = enabled }

    plugin.bindStart(ctx)

    assert.strictEqual(ctx.arguments[1](new Error('request failure')), 'request failure')
    assert.strictEqual(plugin.enabled, false)
  })
})
