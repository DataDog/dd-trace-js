'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * @typedef {object} PromptLRUCache
 * @property {(key: string, options?: object) => ManagedPrompt | undefined} get
 * @property {(key: string, prompt: ManagedPrompt, options?: object) => void} set
 * @property {(key: string, options: object) => Promise<ManagedPrompt | undefined>} fetch
 * @property {(key: string) => void} delete
 * @property {() => void} clear
 * @property {() => Array<[string, object]>} dump
 */

const { LRUCache } = /** @type {{LRUCache: new (options: object) => PromptLRUCache}} */ (
  require('../../../../../vendor/dist/lru-cache')
)

const log = require('../../log')
const ManagedPrompt = require('./prompt')

const MAX_HOT_ENTRIES = 1024

function promptIdFromKey (key) {
  return key.slice(0, key.lastIndexOf(':'))
}

function cacheKey (promptId, selector) {
  const hash = createHash('sha1').update(JSON.stringify(selector)).digest('hex').slice(0, 16)
  return `${promptId}:${hash}`
}

function defaultCacheDir () {
  try {
    const home = os.homedir()
    if (home) return path.join(home, '.cache', 'datadog', 'llmobs', 'prompts')
  } catch {}
  return path.join(os.tmpdir(), 'datadog', 'llmobs', 'prompts')
}

class HotCache {
  /**
   * Create the bounded in-memory prompt cache.
   * @param {object} options
   * @param {number} options.ttlMs
   * @param {(key: string, stale: ManagedPrompt | undefined, options: {context: object}) =>
   *   Promise<ManagedPrompt | undefined>} [options.fetchMethod]
   */
  constructor ({ ttlMs, fetchMethod }) {
    this.enabled = ttlMs > 0
    this.cache = new LRUCache({
      max: MAX_HOT_ENTRIES,
      ttl: ttlMs || undefined,
      allowStale: true,
      noDeleteOnStaleGet: true,
      fetchMethod,
    })
  }

  /**
   * Read a prompt and its freshness.
   * @param {string} key
   * @returns {{prompt: ManagedPrompt, stale: boolean} | undefined}
   */
  get (key) {
    if (!this.enabled) return
    const status = {}
    const prompt = this.cache.get(key, { allowStale: true, noDeleteOnStaleGet: true, status })
    if (!prompt) return
    return { prompt, stale: status.get === 'stale' }
  }

  /**
   * Store a prompt.
   * @param {string} key
   * @param {ManagedPrompt} prompt
   * @param {number} [ageMs]
   * @returns {void}
   */
  set (key, prompt, ageMs = 0) {
    if (this.enabled) this.cache.set(key, prompt, { start: performance.now() - ageMs })
  }

  /**
   * Refresh a stale prompt in the background.
   * @param {string} key
   * @param {object} context
   * @returns {void}
   */
  refresh (key, context) {
    if (!this.enabled) return
    void this.cache.fetch(key, {
      allowStale: true,
      allowStaleOnFetchRejection: true,
      context,
      forceRefresh: true,
      noDeleteOnFetchRejection: true,
    }).catch(() => {})
  }

  /**
   * Delete one selector.
   * @param {string} key
   * @returns {void}
   */
  delete (key) {
    if (this.enabled) this.cache.delete(key)
  }

  /**
   * Clear all hot prompt entries.
   * @returns {void}
   */
  clear () {
    if (this.enabled) this.cache.clear()
  }

  /**
   * Evict every selector for one exact prompt ID.
   * @param {string} promptId
   * @returns {void}
   */
  evictPrompt (promptId) {
    if (!this.enabled) return
    for (const [key] of this.cache.dump()) {
      if (promptIdFromKey(key) === promptId) this.cache.delete(key)
    }
  }
}

class WarmCache {
  /**
   * Create the optional filesystem prompt cache.
   * @param {object} options
   * @param {string | undefined} options.cacheDir
   * @param {boolean} [options.enabled]
   * @param {number} options.ttlMs
   */
  constructor ({ cacheDir, enabled = true, ttlMs }) {
    this.enabled = enabled && ttlMs > 0
    this.ttlMs = ttlMs
    this.cacheDir = cacheDir || defaultCacheDir()
    if (this.enabled) this._ensureDir(this.cacheDir)
  }

  /**
   * Create a secure cache directory.
   * @param {string} directory
   * @returns {void}
   */
  _ensureDir (directory) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    } catch (error) {
      log.warn('Failed to create prompt cache directory: %s', error.message)
      this.enabled = false
    }
  }

  /**
   * Resolve the collision-safe directory for a prompt ID.
   * @param {string} promptId
   * @returns {string}
   */
  _promptDir (promptId) {
    return path.join(this.cacheDir, Buffer.from(promptId).toString('base64url') || '_')
  }

  /**
   * Resolve the cache file for a selector key.
   * @param {string} key
   * @returns {string}
   */
  _path (key) {
    const index = key.lastIndexOf(':')
    return path.join(this._promptDir(key.slice(0, index)), `${key.slice(index + 1)}.json`)
  }

  /**
   * Read a prompt and its freshness.
   * @param {string} key
   * @returns {{prompt: ManagedPrompt, stale: boolean, ageMs: number} | undefined}
   */
  get (key) {
    if (!this.enabled) return
    let result
    try {
      const data = JSON.parse(fs.readFileSync(this._path(key), 'utf8'))
      if (!Number.isFinite(data.timestamp)) throw new TypeError('Invalid prompt cache timestamp')
      const prompt = ManagedPrompt._deserialize(data.prompt)
      const ageMs = Math.max(0, Date.now() - data.timestamp)
      result = { prompt, stale: ageMs > this.ttlMs, ageMs }
    } catch (error) {
      log.debug('Failed to read prompt from cache: %s', error.message)
    }
    return result
  }

  /**
   * Store a prompt with restrictive permissions.
   * @param {string} key
   * @param {ManagedPrompt} prompt
   * @returns {void}
   */
  set (key, prompt) {
    if (!this.enabled) return
    const file = this._path(key)
    const temporary = `${file}.tmp.${process.pid}`
    try {
      this._ensureDir(path.dirname(file))
      if (!this.enabled) return
      fs.writeFileSync(temporary, JSON.stringify({ prompt: prompt._serialize(), timestamp: Date.now() }), {
        encoding: 'utf8',
        mode: 0o600,
      })
      fs.chmodSync(temporary, 0o600)
      fs.renameSync(temporary, file)
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }) } catch {}
      log.debug('Failed to write prompt to cache: %s', error.message)
    }
  }

  /**
   * Delete one selector.
   * @param {string} key
   * @returns {void}
   */
  delete (key) {
    try {
      fs.rmSync(this._path(key), { force: true })
    } catch (error) {
      log.debug('Failed to delete prompt from cache: %s', error.message)
    }
  }

  /**
   * Evict every selector for one exact prompt ID.
   * @param {string} promptId
   * @returns {void}
   */
  evictPrompt (promptId) {
    try {
      fs.rmSync(this._promptDir(promptId), { recursive: true, force: true })
    } catch (error) {
      log.debug('Failed to evict prompt from cache: %s', error.message)
    }
  }

  /**
   * Clear all warm prompt entries.
   * @returns {void}
   */
  clear () {
    try {
      for (const entry of fs.readdirSync(this.cacheDir)) {
        fs.rmSync(path.join(this.cacheDir, entry), { recursive: true, force: true })
      }
    } catch (error) {
      log.debug('Failed to clear prompt cache: %s', error.message)
    }
  }
}

module.exports = { HotCache, WarmCache, cacheKey, promptIdFromKey }
