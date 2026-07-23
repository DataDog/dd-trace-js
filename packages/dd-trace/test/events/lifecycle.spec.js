'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')

const { createLifecycleChannels } = require('../../src/events/lifecycle')

describe('event lifecycle channels', () => {
  it('creates stable semantic channels keyed by lifecycle phase', () => {
    const channels = createLifecycleChannels('tracing:datadog:db:query', ['start', 'finish', 'error'])

    assert.strictEqual(channels.start.name, 'tracing:datadog:db:query:start')
    assert.strictEqual(channels.finish.name, 'tracing:datadog:db:query:finish')
    assert.strictEqual(channels.error.name, 'tracing:datadog:db:query:error')
    assert.strictEqual(
      channels.start,
      createLifecycleChannels('tracing:datadog:db:query', ['start']).start
    )
  })
})
