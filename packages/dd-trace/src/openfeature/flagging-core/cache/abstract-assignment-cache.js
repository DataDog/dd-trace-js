'use strict'

/** Converts an AssignmentCacheKey to a string. */
function assignmentCacheKeyToString(exposureEvent) {
  const key = {
    flag: {
      key: exposureEvent.flag.key,
    },
    subject: {
      id: exposureEvent.subject.id,
      attributes: exposureEvent.subject.attributes,
    },
  }
  return JSON.stringify(key)
}

/** Converts an AssignmentCacheValue to a string. */
function assignmentCacheValueToString(cacheValue) {
  return JSON.stringify(cacheValue)
}

class AbstractAssignmentCache {
  // key -> variation value hash
  constructor(delegate) {
    this.delegate = delegate
  }

  init() {
    return Promise.resolve()
  }

  /** Returns whether the provided AssignmentCacheEntry is present in the cache. */
  has(entry) {
    return this.get(entry) === assignmentCacheValueToString(entry)
  }

  get(key) {
    return this.delegate.get(assignmentCacheKeyToString(key))
  }

  /**
   * Stores the provided AssignmentCacheEntry in the cache. If the key already exists, it
   * will be overwritten.
   */
  set(entry) {
    this.delegate.set(assignmentCacheKeyToString(entry), assignmentCacheValueToString(entry))
  }

  /**
   * Returns an array with all AssignmentCacheEntry entries in the cache as an array of
   * strings.
   */
  entries() {
    return this.delegate.entries()
  }

  /** Clears all entries from the cache. */
  clear() {
    this.delegate.clear()
  }
}

module.exports = {
  assignmentCacheKeyToString,
  assignmentCacheValueToString,
  AbstractAssignmentCache
}