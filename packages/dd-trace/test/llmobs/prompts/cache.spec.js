'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { describe, it } = require('mocha')

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
})
