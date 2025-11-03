'use strict'

const { AbstractAssignmentCache } = require('./abstract-assignment-cache')
const { LRUCache } = require('./lru-cache')

/**
 * A cache that uses the LRU algorithm to evict the least recently used items.
 *
 * It is used to limit the size of the cache.
 *
 * The primary use case is for server-side SDKs, where the cache is shared across
 * multiple users. In this case, the cache size should be set to the maximum number
 * of users that can be active at the same time.
 * @param {number} maxSize - Maximum cache size
 */
class LRUInMemoryAssignmentCache extends AbstractAssignmentCache {
  constructor(maxSize) {
    super(new LRUCache(maxSize))
  }
}

module.exports = {
  LRUInMemoryAssignmentCache
}