'use strict'

/**
 * LRUCache is a simple implementation of a Least Recently Used (LRU) cache.
 *
 * Old items are evicted when the cache reaches its capacity.
 *
 * The cache is implemented as a Map, which maintains insertion order:
 * ```
 * Iteration happens in insertion order, which corresponds to the order in which each key-value pair
 * was first inserted into the map by the set() method (that is, there wasn't a key with the same
 * value already in the map when set() was called).
 * ```
 * Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map
 */
class LRUCache {
  constructor(capacity) {
    this.capacity = capacity
    this.cache = new Map()
  }

  [Symbol.iterator]() {
    return this.cache[Symbol.iterator]()
  }

  forEach(callbackFn) {
    this.cache.forEach(callbackFn)
  }

  get size() {
    return this.cache.size
  }

  entries() {
    return this.cache.entries()
  }

  clear() {
    this.cache.clear()
  }

  delete(key) {
    return this.cache.delete(key)
  }

  keys() {
    return this.cache.keys()
  }

  values() {
    return this.cache.values()
  }

  has(key) {
    return this.cache.has(key)
  }

  get(key) {
    if (!this.has(key)) {
      return undefined
    }

    const value = this.cache.get(key)

    if (value !== undefined) {
      // the delete and set operations are used together to ensure that the most recently accessed
      // or added item is always considered the "newest" in terms of access order.
      // This is crucial for maintaining the correct order of elements in the cache,
      // which directly impacts which item is considered the least recently used (LRU) and
      // thus eligible for eviction when the cache reaches its capacity.
      this.delete(key)
      this.cache.set(key, value)
    }

    return value
  }

  set(key, value) {
    if (this.capacity === 0) {
      return this
    }

    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.capacity) {
      // To evict the least recently used (LRU) item, we retrieve the first key in the Map.
      // This is possible because the Map object in JavaScript maintains the insertion order of the keys.
      // Therefore, the first key represents the oldest entry, which is the least recently used item in our cache.
      // We use Map.prototype.keys().next().value to obtain this oldest key and then delete it from the cache.
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) {
        this.delete(oldestKey)
      }
    }

    this.cache.set(key, value)
    return this
  }
}

module.exports = {
  LRUCache
}