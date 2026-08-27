'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { HotCache, WarmCache, cacheKey } = require('../../../src/llmobs/prompts/cache')
const ManagedPrompt = require('../../../src/llmobs/prompts/prompt')

const WARM_OPTIONS = { ttlMs: 60_000, origin: 'https://api.datadoghq.com', apiKey: 'api-key' }

describe('Prompt caches', () => {
  let cacheDir

  afterEach(() => {
    sinon.restore()
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  function prompt (id) {
    return new ManagedPrompt({ id, version: '1', source: 'cache', template: 'x' })
  }

  it('enforces the 1024-entry LRU boundary', () => {
    const cache = new HotCache({ ttlMs: 60_000 })
    for (let index = 0; index < 1024; index++) cache.set(String(index), prompt(String(index)))
    assert.strictEqual(cache.get('0').prompt.id, '0')

    cache.set('1024', prompt('1024'))

    assert.strictEqual(cache.get('1'), undefined)
    assert.strictEqual(cache.get('0').prompt.id, '0')
    assert.strictEqual(cache.get('1024').prompt.id, '1024')
  })

  it('returns stale data immediately and deduplicates background refreshes', async () => {
    const now = sinon.stub(performance, 'now').returns(100)
    let resolveFetch
    const fetchMethod = sinon.stub().returns(new Promise(resolve => { resolveFetch = resolve }))
    const cache = new HotCache({ ttlMs: 60_000, fetchMethod })
    cache.set('key', prompt('old'))
    now.returns(60_101)

    for (let index = 0; index < 2; index++) {
      const stale = cache.get('key')
      assert.strictEqual(stale.prompt.id, 'old')
      assert.strictEqual(stale.stale, true)
      cache.refresh('key', { promptId: 'p' })
    }

    sinon.assert.calledOnce(fetchMethod)
    resolveFetch(prompt('new'))
    await Promise.resolve()
    await Promise.resolve()
    assert.strictEqual(cache.get('key').prompt.id, 'new')
  })

  it('stores collision-safe prompt paths with secure modes and tolerates malformed entries', () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-cache-'))
    const cache = new WarmCache({ cacheDir, ...WARM_OPTIONS })
    const slashKey = cacheKey('a/b', ['latest'])
    const underscoreKey = cacheKey('a_b', ['latest'])
    cache.set(slashKey, prompt('a/b'))
    cache.set(underscoreKey, prompt('a_b'))

    assert.strictEqual(cache.get(slashKey).prompt.id, 'a/b')
    assert.strictEqual(cache.get(underscoreKey).prompt.id, 'a_b')
    assert.strictEqual(fs.statSync(cacheDir).mode & 0o777, 0o700)
    const files = fs.readdirSync(cache.cacheDir).flatMap(directory => {
      return fs.readdirSync(path.join(cache.cacheDir, directory))
        .map(file => path.join(cache.cacheDir, directory, file))
    })
    for (const file of files) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
    assert.strictEqual(files.some(file => file.includes('.tmp.')), false)

    const slashFile = cache._path(slashKey)
    fs.writeFileSync(slashFile, 'not json')
    assert.strictEqual(cache.get(slashKey), undefined)
    fs.writeFileSync(slashFile, JSON.stringify({ prompt: {}, timestamp: Date.now() }))
    assert.strictEqual(cache.get(slashKey), undefined)
    fs.writeFileSync(slashFile, JSON.stringify({ prompt: prompt('a/b')._serialize() }))
    assert.strictEqual(cache.get(slashKey), undefined)
  })

  it('falls back to the temporary directory when no home directory can be resolved', () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-cache-home-'))
    sinon.stub(os, 'homedir').throws(new Error('no home'))
    sinon.stub(os, 'tmpdir').returns(cacheDir)

    const cache = new WarmCache({ ...WARM_OPTIONS })
    cache.set(cacheKey('prompt', ['latest']), prompt('prompt'))

    assert.strictEqual(path.dirname(cache.cacheDir), path.join(cacheDir, 'datadog', 'llmobs', 'prompts'))
    assert.match(path.basename(cache.cacheDir), /^v1-[a-f0-9]{64}$/)
  })

  it('isolates tenant-owned files and preserves unrelated cache-root data when clearing', () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-cache-tenants-'))
    const first = new WarmCache({ cacheDir, ...WARM_OPTIONS })
    const second = new WarmCache({ cacheDir, ...WARM_OPTIONS, apiKey: 'other-api-key' })
    const key = cacheKey('shared', ['latest'])
    first.set(key, prompt('first'))
    second.set(key, prompt('second'))
    fs.writeFileSync(path.join(cacheDir, 'unrelated.txt'), 'keep')

    assert.strictEqual(first.get(key).prompt.id, 'first')
    assert.strictEqual(second.get(key).prompt.id, 'second')

    first.clear()

    assert.strictEqual(first.get(key), undefined)
    assert.strictEqual(second.get(key).prompt.id, 'second')
    assert.strictEqual(fs.readFileSync(path.join(cacheDir, 'unrelated.txt'), 'utf8'), 'keep')
  })

  it('clears and evicts owned files even when warm reads and writes are disabled', () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-cache-disabled-'))
    const enabled = new WarmCache({ cacheDir, ...WARM_OPTIONS })
    const disabled = new WarmCache({ cacheDir, ...WARM_OPTIONS, enabled: false })
    const key = cacheKey('prompt', ['latest'])
    enabled.set(key, prompt('prompt'))

    disabled.evictPrompt('prompt')
    assert.strictEqual(enabled.get(key), undefined)

    enabled.set(key, prompt('prompt'))
    disabled.clear()
    assert.strictEqual(enabled.get(key), undefined)
  })

  it('preserves warm entry age when promoting it to the hot cache', () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-cache-age-'))
    const wallClock = sinon.stub(Date, 'now').returns(1_000)
    sinon.stub(performance, 'now').returns(100)
    const warm = new WarmCache({ cacheDir, ...WARM_OPTIONS })
    const hot = new HotCache({ ttlMs: 60_000 })
    const key = cacheKey('prompt', ['latest'])
    warm.set(key, prompt('prompt'))
    wallClock.returns(60_000)

    const entry = warm.get(key)
    hot.set(key, entry.prompt, entry.ageMs)

    assert.strictEqual(Math.round(hot.cache.getRemainingTTL(key)), 1_000)
  })
})
