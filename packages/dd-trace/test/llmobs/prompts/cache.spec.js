'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { HotCache, WarmCache, cacheKey } = require('../../../src/llmobs/prompts/cache')
const ManagedPrompt = require('../../../src/llmobs/prompts/prompt')

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
    const cache = new WarmCache({ cacheDir, ttlMs: 60_000 })
    const slashKey = cacheKey('a/b', ['latest'])
    const underscoreKey = cacheKey('a_b', ['latest'])
    cache.set(slashKey, prompt('a/b'))
    cache.set(underscoreKey, prompt('a_b'))

    assert.strictEqual(cache.get(slashKey).prompt.id, 'a/b')
    assert.strictEqual(cache.get(underscoreKey).prompt.id, 'a_b')
    assert.strictEqual(fs.statSync(cacheDir).mode & 0o777, 0o700)
    const files = fs.readdirSync(cacheDir).flatMap(directory => {
      return fs.readdirSync(path.join(cacheDir, directory)).map(file => path.join(cacheDir, directory, file))
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

    const cache = new WarmCache({ ttlMs: 60_000 })
    cache.set(cacheKey('prompt', ['latest']), prompt('prompt'))

    assert.strictEqual(cache.cacheDir, path.join(cacheDir, 'datadog', 'llmobs', 'prompts'))
  })
})
