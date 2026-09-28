'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { ItemText } = require('../../src/openai-realtime/turns')

describe('ItemText', () => {
  it('accumulates deltas for a single item', () => {
    const text = new ItemText()

    text.appendDelta('out_1', 'Hel')
    text.appendDelta('out_1', 'lo')

    assert.strictEqual(text.value, 'Hello')
  })

  it('replaces an item span with the final value the server reported for it', () => {
    const text = new ItemText()

    text.appendDelta('out_1', 'Hel')
    text.complete('out_1', 'Hello')

    assert.strictEqual(text.value, 'Hello')
  })

  // A response can hold several output items — a server-side MCP call sits between a preamble
  // message and the answer — and each ends with its own `.done`. Completing one must not discard
  // what the items before it contributed.
  it('keeps earlier items when a later one completes', () => {
    const text = new ItemText()

    text.appendDelta('out_1', 'Hello')
    text.complete('out_1', 'Hello')
    text.appendDelta('out_2', ' there')
    text.complete('out_2', ' there')

    assert.strictEqual(text.value, 'Hello there')
  })

  it('appends an item that completes without having streamed any delta', () => {
    const text = new ItemText()

    text.appendDelta('out_1', 'Hello')
    text.complete('out_2', ' there')

    assert.strictEqual(text.value, 'Hello there')
  })

  it('lets a later delta for an item extend the value its done had set', () => {
    const text = new ItemText()

    text.complete('out_1', 'Hello')
    text.appendDelta('out_1', '!')

    assert.strictEqual(text.value, 'Hello!')
  })

  // Events without an item id are one continuous item, which is how a single-item response behaves
  // anyway — so a `.done` replaces everything, as it did before items were tracked.
  it('treats events with no item id as one item', () => {
    const text = new ItemText()

    text.appendDelta(undefined, 'Hel')
    text.appendDelta(undefined, 'lo')
    text.complete(undefined, 'Hello there')

    assert.strictEqual(text.value, 'Hello there')
  })

  it('starts empty', () => {
    assert.strictEqual(new ItemText().value, '')
  })
})
