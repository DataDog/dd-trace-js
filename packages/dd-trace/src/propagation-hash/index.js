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
  #containerTagsHash = null
  #cachedHash = null
  #cachedHashString = null
  #cachedHashBase64 = null
  #config = null

  /**
   * Configure the propagation hash manager with tracer config
   * @param {object} config - Tracer configuration
   */
  configure (config) {
    this.#config = config
  }

  /**
   * Check if process tags propagation is enabled
   * @returns {boolean}
   */
  isEnabled () {
    return this.#config?.propagateProcessTags?.enabled === true
  }

  /**
   * Update the container tags hash received from the agent
   * @param {string} hash - Container tags hash from agent response
   */
  updateContainerTagsHash (hash) {
    if (hash !== this.#containerTagsHash) {
      log.debug('Updating container tags hash: %s', hash)
      this.#containerTagsHash = hash
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
    if (this.#cachedHash) {
      return this.#cachedHash
    }
    this._computeHash()
    return this.#cachedHash
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
    if (!this.#cachedHashString) {
      this.#cachedHashString = hash.toString(16)
    }
    return this.#cachedHashString
  }

  /**
   * Get the propagation hash as a base64 string
   * @returns {string|null} The propagation hash in base64 format or null if disabled/unavailable
   */
  getHashBase64 () {
    const hash = this.getHash()
    if (!hash) {
      return null
    }
    if (!this.#cachedHashBase64) {
      // Convert BigInt to 8-byte buffer (64-bit hash)
      const buffer = Buffer.allocUnsafe(8)
      // Write as big-endian 64-bit unsigned integer
      buffer.writeBigUInt64BE(hash, 0)
      this.#cachedHashBase64 = buffer.toString('base64')
    }
    return this.#cachedHashBase64
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
      const input = processTags.serialized + (this.#containerTagsHash || '')

      if (!input) {
        // If both are empty, don't compute a hash
        this.#cachedHash = null
        this.#cachedHashString = null
        this.#cachedHashBase64 = null
        return
      }

      // Compute FNV-1a 64-bit hash
      this.#cachedHash = fnv64(input)
      this.#cachedHashString = null // Will be computed on demand
      this.#cachedHashBase64 = null // Will be computed on demand

      log.debug('Computed propagation hash from input (length=%s): "%s"', input.length, this.#cachedHash.toString(16))
    } catch (e) {
      log.error('Error computing propagation hash', e)
      this.#cachedHash = null
      this.#cachedHashString = null
      this.#cachedHashBase64 = null
    }
  }

  /**
   * Invalidate the cached hash
   * @private
   */
  _invalidateCache () {
    this.#cachedHash = null
    this.#cachedHashString = null
    this.#cachedHashBase64 = null
  }
}

// Export singleton instance
module.exports = new PropagationHashManager()
