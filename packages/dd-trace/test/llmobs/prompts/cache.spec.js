'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { HotCache, WarmCache, cacheKey } = require('../../../src/llmobs/prompts/cache')
const ManagedPrompt = require('../../../src/llmobs/prompts/prompt')

const WARM_OPTIONS = { ttlMs: 60_000 }

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

  it('handles TTL values unsupported by the native LRU', () => {
    const disabled = new HotCache({ ttlMs: -1 })
    disabled.set('key', prompt('disabled'))
    assert.strictEqual(disabled.get('key'), undefined)

    const unlimited = new HotCache({ ttlMs: Infinity })
    unlimited.set('key', prompt('unlimited'))
    assert.strictEqual(unlimited.get('key').prompt.id, 'unlimited')
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

    const slashFile = files.find(file => JSON.parse(fs.readFileSync(file, 'utf8')).prompt.id === 'a/b')
    assert.ok(slashFile)
    const serializedPrompt = JSON.parse(fs.readFileSync(slashFile, 'utf8')).prompt
    fs.writeFileSync(slashFile, 'not json')
    assert.strictEqual(cache.get(slashKey), undefined)
    fs.writeFileSync(slashFile, JSON.stringify({ prompt: {}, timestamp: Date.now() }))
    assert.strictEqual(cache.get(slashKey), undefined)
    fs.writeFileSync(slashFile, JSON.stringify({ prompt: serializedPrompt }))
    assert.strictEqual(cache.get(slashKey), undefined)
  })

  it('uses a unique temporary file for each warm cache write', () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-cache-temporary-'))
    const cache = new WarmCache({ cacheDir, ...WARM_OPTIONS })
    const rename = sinon.spy(fs, 'renameSync')
    const key = cacheKey('prompt', ['latest'])

    cache.set(key, prompt('prompt'))
    cache.set(key, prompt('prompt'))

    assert.notStrictEqual(rename.firstCall.args[0], rename.secondCall.args[0])
  })

  it('falls back to the temporary directory when no home directory can be resolved', () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-cache-home-'))
    sinon.stub(os, 'homedir').throws(new Error('no home'))
    sinon.stub(os, 'tmpdir').returns(cacheDir)

    const cache = new WarmCache({ ...WARM_OPTIONS })
    cache.set(cacheKey('prompt', ['latest']), prompt('prompt'))

    assert.strictEqual(cache.cacheDir, path.join(cacheDir, 'datadog', 'llmobs', 'prompts'))
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
