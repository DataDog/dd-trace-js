'use strict'

const { AbstractAssignmentCache } = require('./abstract-assignment-cache')

/**
 * A cache that never expires.
 *
 * The primary use case is for client-side SDKs, where the cache is only used
 * for a single user.
 */
class NonExpiringInMemoryAssignmentCache extends AbstractAssignmentCache {
  constructor(store = new Map()) {
    super(store)
  }
}

module.exports = {
  NonExpiringInMemoryAssignmentCache
}