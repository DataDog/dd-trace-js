'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { describe, it } = require('mocha')
const sinon = require('sinon')

const { HotCache, WarmCache } = require('../../../src/llmobs/prompts/cache')
const { cacheKey } = require('../../../src/llmobs/prompts/util')

describe('prompt caches', () => {
  it('provides TTL, LRU, and exact prompt eviction', () => {
    const cache = new HotCache({ ttl: 1, maxSize: 2 })
    const a = cacheKey({ id: 'foo' })
    const b = cacheKey({ id: 'foo:bar' })
    cache.set(a, 1)
    cache.set(b, 2)
    cache.get(a)
    cache.set(cacheKey({ id: 'third' }), 3)
    assert.strictEqual(cache.get(b), undefined)
    cache.evictPrompt('foo')
    assert.strictEqual(cache.get(a), undefined)
    assert.strictEqual(cache.get(cacheKey({ id: 'foo:bar' })), undefined)
  })

  it('round-trips and evicts warm cache files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompts-'))
    const cache = new WarmCache({ dir, ttl: 60 })
    const key = cacheKey({ id: 'foo' })
    cache.set(key, { value: 'ok' })
    assert.deepEqual(cache.get(key), { value: 'ok' })
    cache.evictPrompt('foo')
    assert.strictEqual(cache.get(key), undefined)
    cache.clear()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('expires hot entries according to the configured TTL', () => {
    const clock = sinon.useFakeTimers()
    try {
      const cache = new HotCache({ ttl: 1 })
      cache.set('key', 'value')
      assert.strictEqual(cache.get('key'), 'value')
      clock.tick(1001)
      assert.strictEqual(cache.get('key'), undefined)
    } finally {
      clock.restore()
    }
  })

  it('disables both cache operations when TTL is zero', () => {
    const hot = new HotCache({ ttl: 0 })
    hot.set('key', 'value')
    assert.strictEqual(hot.get('key'), undefined)
    const warm = new WarmCache({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompts-')), ttl: 0 })
    warm.set('key', 'value')
    assert.strictEqual(warm.get('key'), undefined)
  })

  it('does not evict colon-prefixed prompt IDs', () => {
    const cache = new HotCache()
    cache.set(cacheKey({ id: 'foo' }), 'foo')
    cache.set(cacheKey({ id: 'foo:bar' }), 'foo:bar')
    cache.evictPrompt('foo')
    assert.strictEqual(cache.get(cacheKey({ id: 'foo' })), undefined)
    assert.strictEqual(cache.get(cacheKey({ id: 'foo:bar' })), 'foo:bar')
  })

  it('tolerates corrupt warm cache files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompts-'))
    const cache = new WarmCache({ dir })
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{')
    assert.strictEqual(cache.get('missing'), undefined)
    cache.clear()
  })

  it('round-trips managed prompts through warm cache', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompts-'))
    const { ManagedPrompt } = require('../../../src/llmobs/prompts/prompt')
    const cache = new WarmCache({ dir })
    const key = cacheKey({ id: 'prompt' })
    cache.set(key, ManagedPrompt.fromResponse({ prompt_id: 'prompt', version: 1, template: 'Hi' }))
    assert.strictEqual(cache.get(key).template, 'Hi')
    cache.clear()
  })
})
