'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../setup/core')

const { createOtelLinkExtractor } = require('../../../src/profiling/profilers/shared')

describe('profilers/shared', () => {
  describe('createOtelLinkExtractor', () => {
    it('turns span and trace ID labels into a link, and removes them', () => {
      const extractLink = createOtelLinkExtractor()
      const traceId = (0x0102030405060708n << 64n) | 0x090a0b0c0d0e0f10n

      const { link, labels } = extractLink([
        ['thread.name', 'Main Event Loop'],
        ['span id', 42n],
        ['trace id', traceId],
      ])

      assert.deepStrictEqual(labels, [['thread.name', 'Main Event Loop']])
      assert.strictEqual(Buffer.from(link.traceId).toString('hex'), '0102030405060708090a0b0c0d0e0f10')
      assert.strictEqual(Buffer.from(link.spanId).toString('hex'), '000000000000002a')
    })

    it('shares the link of a span between its samples', () => {
      const extractLink = createOtelLinkExtractor()
      const labels = [['span id', 42n], ['trace id', 9n]]

      assert.strictEqual(extractLink(labels).link, extractLink(labels).link)
      assert.notStrictEqual(extractLink(labels).link, extractLink([['span id', 43n], ['trace id', 9n]]).link)
    })

    it('makes no link without both IDs', () => {
      const extractLink = createOtelLinkExtractor()

      assert.deepStrictEqual(extractLink([['span id', 42n]]), { labels: [] })
      assert.deepStrictEqual(extractLink([['trace id', 9n], ['thread.id', 0]]), { labels: [['thread.id', 0]] })
    })
  })
})
