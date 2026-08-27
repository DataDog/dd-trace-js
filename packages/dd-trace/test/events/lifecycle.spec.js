'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const dc = require('dc-polyfill')

const { createLifecycleChannels } = require('../../src/events/lifecycle')

describe('createLifecycleChannels', () => {
  it('creates the requested semantic phases with stable channel identities', () => {
    const channels = createLifecycleChannels('datadog:test:lifecycle', ['start', 'finish'])

    assert.deepStrictEqual(Object.keys(channels), ['start', 'finish'])
    assert.strictEqual(channels.start, dc.channel('datadog:test:lifecycle:start'))
    assert.strictEqual(channels.finish, dc.channel('datadog:test:lifecycle:finish'))
  })
})
