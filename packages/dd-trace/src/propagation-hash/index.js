'use strict'

const { fnv64 } = require('../datastreams/fnv')
const log = require('../log')

/**
 * PropagationHashManager is a singleton that manages the propagation hash computation.
 * The propagation hash is an FNV-1a 64-bit hash combining:
 * - Process tags (entrypoint info, package.json name, etc.)
 * - Container tags hash (received from the Datadog agent)
 *
 * This hash is used to correlate traces with database operations (DBM) and
 * data stream pathways (DSM) for enhanced observability.
 */
class PropagationHashManager {
  _containerTagsHash = null
  _cachedHash = null
  _cachedHashString = null
  _config = null

  /**
   * Configure the propagation hash manager with tracer config
   * @param {object} config - Tracer configuration
   */
  configure (config) {
    this._config = config
  }

  /**
   * Check if process tags propagation is enabled
   * @returns {boolean}
   */
  isEnabled () {
    return this._config?.propagateProcessTags?.enabled === true
  }

  /**
   * Update the container tags hash received from the agent
   * @param {string} hash - Container tags hash from agent response
   */
  updateContainerTagsHash (hash) {
    if (hash !== this._containerTagsHash) {
      log.debug('Updating container tags hash: %s', hash)
      this._containerTagsHash = hash
      this._invalidateCache()
    }
  }

  /**
   * Get the propagation hash as a BigInt
   * @returns {bigint | null} The propagation hash or null if disabled/unavailable
   */
  getHash () {
    if (!this.isEnabled()) {
      return null
    }
    if (this._cachedHash) {
      return this._cachedHash
    }
    this._computeHash()
    return this._cachedHash
  }

  /**
   * Get the propagation hash as a hexadecimal string
   * @returns {string|null} The propagation hash in hex format or null if disabled/unavailable
   */
  getHashString () {
    const hash = this.getHash()
    if (!hash) {
      return null
    }
    if (!this._cachedHashString) {
      this._cachedHashString = hash.toString(16)
    }
    return this._cachedHashString
  }

  /**
   * Compute the propagation hash using FNV-1a algorithm
   * @private
   */
  _computeHash () {
    try {
      const processTags = require('../process-tags')

      // Combine process tags and container tags hash
      // Process tags are already serialized as a comma-separated string
      const input = processTags.serialized + (this._containerTagsHash || '')

      if (!input) {
        // If both are empty, don't compute a hash
        this._cachedHash = null
        this._cachedHashString = null
        return
      }

      // Compute FNV-1a 64-bit hash
      this._cachedHash = fnv64(input)
      this._cachedHashString = null // Will be computed on demand

      log.debug(() => `Computed propagation hash from input length ${input.length}: ${this._cachedHash.toString(16)}`)
    } catch (e) {
      log.error('Error computing propagation hash', e)
      this._cachedHash = null
      this._cachedHashString = null
    }
  }

  /**
   * Invalidate the cached hash
   * @private
   */
  _invalidateCache () {
    this._cachedHash = null
    this._cachedHashString = null
  }
}

// Export singleton instance
module.exports = new PropagationHashManager()
