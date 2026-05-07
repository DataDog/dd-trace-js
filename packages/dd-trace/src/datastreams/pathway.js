'use strict'

// encoding used here is sha256
// other languages use FNV1
// this inconsistency is ok because hashes do not need to be consistent across services
const crypto = require('crypto')
const { LRUCache } = require('../../../../vendor/dist/lru-cache')
const log = require('../log')
const pick = require('../../../datadog-core/src/utils/src/pick')
const { encodeVarintInto, decodeVarint } = require('./encoding')

const cache = new LRUCache({ max: 500 })

const CONTEXT_PROPAGATION_KEY = 'dd-pathway-ctx'
const CONTEXT_PROPAGATION_KEY_BASE64 = 'dd-pathway-ctx-base64'

const PATHWAY_CONTEXT_BYTES = 20

// Reused across `encodePathwayContext` calls; the buffer is fully rewritten before each
// `Buffer.from(...)` copy-out so callers never observe mutation between checkpoints.
const pathwayScratch = Buffer.allocUnsafe(PATHWAY_CONTEXT_BYTES)

const logKeys = [CONTEXT_PROPAGATION_KEY, CONTEXT_PROPAGATION_KEY_BASE64]

function shaHash (checkpointString) {
  // Copy out of the 32-byte digest so the LRU cache doesn't retain it.
  return Buffer.from(crypto.createHash('sha256').update(checkpointString).digest().subarray(0, 8))
}

/**
 * @param {string} service
 * @param {string} env
 * @param {string[]} edgeTags
 * @param {Buffer} parentHash
 * @param {bigint | null} propagationHashBigInt - Optional propagation hash for process/container tags
 */
function computeHash (service, env, edgeTags, parentHash, propagationHashBigInt = null) {
  edgeTags.sort()
  const hashableEdgeTags = edgeTags.includes('manual_checkpoint:true')
    ? edgeTags.filter(item => item !== 'manual_checkpoint:true')
    : edgeTags

  // The cache key includes parentHash so a fan-in node with different parents
  // gets distinct cache entries; the hash input below excludes parentHash and
  // gets combined with it via a second sha pass to produce the final hash.
  const joinedEdgeTags = hashableEdgeTags.join('')
  const propagationHex = propagationHashBigInt ? propagationHashBigInt.toString(16) : ''
  const propagationPart = propagationHex ? `:${propagationHex}` : ''
  const key = `${service}${env}${joinedEdgeTags}${parentHash}${propagationPart}`

  let value = cache.get(key)
  if (value) {
    return value
  }

  const baseString = `${service}${env}${joinedEdgeTags}`
  const hashInput = propagationHex ? `${baseString}:${propagationHex}` : baseString

  const currentHash = shaHash(hashInput)
  const buf = Buffer.concat([currentHash, parentHash], 16)
  value = shaHash(buf.toString())
  cache.set(key, value)
  return value
}

/**
 * @param {object} dataStreamsContext
 * @param {Buffer} dataStreamsContext.hash
 * @param {number} dataStreamsContext.pathwayStartNs
 * @param {number} dataStreamsContext.edgeStartNs
 * @returns {Buffer}
 */
function encodePathwayContext (dataStreamsContext) {
  let offset = dataStreamsContext.hash.copy(pathwayScratch, 0)
  offset = encodeVarintInto(pathwayScratch, offset, Math.round(dataStreamsContext.pathwayStartNs / 1e6))
  offset = encodeVarintInto(pathwayScratch, offset, Math.round(dataStreamsContext.edgeStartNs / 1e6))
  // No-op when offset >= PATHWAY_CONTEXT_BYTES; otherwise pads stale bytes from a previous call.
  pathwayScratch.fill(0, offset, PATHWAY_CONTEXT_BYTES)
  return Buffer.from(pathwayScratch.subarray(0, PATHWAY_CONTEXT_BYTES))
}

/**
 * @param {object} dataStreamsContext
 * @param {Buffer} dataStreamsContext.hash
 * @param {number} dataStreamsContext.pathwayStartNs
 * @param {number} dataStreamsContext.edgeStartNs
 * @returns {string}
 */
function encodePathwayContextBase64 (dataStreamsContext) {
  const encodedPathway = encodePathwayContext(dataStreamsContext)
  return encodedPathway.toString('base64')
}

/**
 * @param {Buffer} pathwayContext
 * @returns {object}
 */
function decodePathwayContext (pathwayContext) {
  if (pathwayContext == null || pathwayContext.length < 8) {
    return null
  }
  // hash and parent hash are in LE
  const pathwayHash = pathwayContext.subarray(0, 8)
  const encodedTimestamps = pathwayContext.subarray(8)
  const [pathwayStartMs, encodedTimeSincePrev] = decodeVarint(encodedTimestamps)
  if (pathwayStartMs === undefined) {
    return null
  }
  const [edgeStartMs] = decodeVarint(encodedTimeSincePrev)
  if (edgeStartMs === undefined) {
    return null
  }
  return { hash: pathwayHash, pathwayStartNs: pathwayStartMs * 1e6, edgeStartNs: edgeStartMs * 1e6 }
}

/**
 * @param {string} pathwayContext
 * @returns {ReturnType<typeof decodePathwayContext>|undefined}
 */
function decodePathwayContextBase64 (pathwayContext) {
  if (pathwayContext == null || pathwayContext.length < 8) {
    return
  }
  if (Buffer.isBuffer(pathwayContext)) {
    pathwayContext = pathwayContext.toString()
  }
  const encodedPathway = Buffer.from(pathwayContext, 'base64')
  return decodePathwayContext(encodedPathway)
}

const DsmPathwayCodec = {
  // we use a class for encoding / decoding in case we update our encoding/decoding. A class will make updates easier
  // instead of using individual functions.
  /**
   * @param {object} dataStreamsContext
   * @param {Buffer} dataStreamsContext.hash
   * @param {number} dataStreamsContext.pathwayStartNs
   * @param {number} dataStreamsContext.edgeStartNs
   * @param {object} carrier
   */
  encode (dataStreamsContext, carrier) {
    if (!dataStreamsContext || !dataStreamsContext.hash) {
      return
    }
    carrier[CONTEXT_PROPAGATION_KEY_BASE64] = encodePathwayContextBase64(dataStreamsContext)

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Injected into DSM carrier: ${JSON.stringify(pick(carrier, logKeys))}.`)
  },

  /**
   * @param {object} carrier
   * @returns {ReturnType<typeof decodePathwayContext>|undefined}
   */
  decode (carrier) {
    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Attempting extract from DSM carrier: ${JSON.stringify(pick(carrier, logKeys))}.`)

    if (carrier == null) return

    let ctx
    if (CONTEXT_PROPAGATION_KEY_BASE64 in carrier) {
      // decode v2 encoding of base64
      ctx = decodePathwayContextBase64(carrier[CONTEXT_PROPAGATION_KEY_BASE64])
    } else if (CONTEXT_PROPAGATION_KEY in carrier) {
      try {
        // decode v1 encoding
        ctx = decodePathwayContext(carrier[CONTEXT_PROPAGATION_KEY])
      } catch {
        // pass
      }
      // cover case where base64 context was received under wrong key
      if (!ctx && CONTEXT_PROPAGATION_KEY in carrier) {
        ctx = decodePathwayContextBase64(carrier[CONTEXT_PROPAGATION_KEY])
      }
    }

    return ctx
  },
}

module.exports = {
  CONTEXT_PROPAGATION_KEY_BASE64,
  computePathwayHash: computeHash,
  encodePathwayContext,
  decodePathwayContext,
  encodePathwayContextBase64,
  decodePathwayContextBase64,
  DsmPathwayCodec,
}
