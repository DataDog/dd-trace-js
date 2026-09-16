'use strict'

const fs = require('node:fs')
const path = require('node:path')
const log = require('../../log')
const { cacheHash, parseCacheKey } = require('./util')

class HotCache {
  #ttl
  #maxSize
  #entries = new Map()

  /**
   * @param {{ttl?: number, maxSize?: number}} options
   */
  constructor ({ ttl = 60, maxSize = 1024 } = {}) {
    this.#ttl = ttl
    this.#maxSize = maxSize
  }

  get (key) {
    if (this.#ttl <= 0) return
    const entry = this.#entries.get(key)
    if (!entry) return
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key)
      return
    }
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set (key, value) {
    if (this.#ttl <= 0) return
    this.#entries.delete(key)
    this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttl * 1000 })
    while (this.#entries.size > this.#maxSize) {
      this.#entries.delete(this.#entries.keys().next().value)
    }
  }

  delete (key) {
    this.#entries.delete(key)
  }

  clear () {
    this.#entries.clear()
  }

  evictPrompt (promptId) {
    for (const key of this.#entries.keys()) {
      if (parseCacheKey(key).id === promptId) this.#entries.delete(key)
    }
  }

  get size () {
    return this.#entries.size
  }
}

class WarmCache {
  #dir
  #ttl

  /**
   * @param {{dir?: string, ttl?: number}} options
   */
  constructor ({ dir, ttl = 60 } = {}) {
    this.#dir = dir
    this.#ttl = ttl
    if (dir) this.#mkdir(dir)
  }

  #mkdir (directory) {
    try {
      fs.mkdirSync(directory, { recursive: true })
    } catch (error) {
      log.debug('Failed to create prompt cache directory: %s', error.message)
    }
  }

  #path (key) {
    return path.join(/** @type {string} */ (this.#dir), `${cacheHash(key)}.json`)
  }

  get (key) {
    if (!this.#dir || this.#ttl <= 0) return
    try {
      const data = JSON.parse(fs.readFileSync(this.#path(key), 'utf8'))
      if (data.timestamp + this.#ttl * 1000 <= Date.now()) {
        this.delete(key)
        return
      }
      if (data.value?._managedPrompt) {
        const { ManagedPrompt } = require('./prompt')
        return ManagedPrompt.fromCache(data.value._managedPrompt)
      }
      return data.value
    } catch (error) {
      if (error.code !== 'ENOENT') log.debug('Failed to read prompt from cache: %s', error.message)
    }
  }

  set (key, value) {
    if (!this.#dir || this.#ttl <= 0) return
    try {
      this.#mkdir(this.#dir)
      let stored = value
      if (value?.constructor?.name === 'ManagedPrompt' && typeof value._serialize === 'function') {
        stored = { _managedPrompt: value._serialize() }
      }
      fs.writeFileSync(this.#path(key), JSON.stringify({
        promptId: parseCacheKey(key).id,
        key,
        timestamp: Date.now(),
        value: stored,
      }))
    } catch (error) {
      log.debug('Failed to write prompt to cache: %s', error.message)
    }
  }

  delete (key) {
    if (!this.#dir) return
    try {
      fs.rmSync(this.#path(key), { force: true })
    } catch (error) {
      log.debug('Failed to delete prompt cache entry: %s', error.message)
    }
  }

  clear () {
    if (!this.#dir) return
    try {
      for (const file of fs.readdirSync(this.#dir)) {
        fs.rmSync(path.join(this.#dir, file), { recursive: true, force: true })
      }
    } catch (error) {
      log.debug('Failed to clear prompt cache: %s', error.message)
    }
  }

  evictPrompt (promptId) {
    if (!this.#dir) return
    try {
      for (const file of fs.readdirSync(this.#dir)) {
        const filename = path.join(this.#dir, file)
        try {
          const data = JSON.parse(fs.readFileSync(filename, 'utf8'))
          if (data.promptId === promptId) fs.rmSync(filename, { force: true })
        } catch (error) {
          log.debug('Failed to inspect prompt cache entry: %s', error.message)
        }
      }
    } catch (error) {
      log.debug('Failed to evict prompt cache entries: %s', error.message)
    }
  }
}

module.exports = { HotCache, WarmCache }
