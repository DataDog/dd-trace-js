'use strict'

// encoding used here is sha256
// other languages use FNV1
// this inconsistency is ok because hashes do not need to be consistent across services
const crypto = require('crypto')
const {
  hasDsmBase64,
  hasDsmBinary,
  pickDsm,
  readDsmBase64,
  readDsmBinary,
  writeDsmBase64,
} = require('../carrier')
const log = require('../log')
const { encodeVarintInto, decodeVarint } = require('./encoding')

const MAX_CACHED_PATHWAY_HASHES = 500

/**
 * Keyed by the exact string that is hashed for the current node (service, env, edge tags and propagation hash).
 * Each entry holds that string's hash and the final hashes per parent hash, keyed losslessly by the parent's
 * bytes so distinct parent hashes never share an entry.
 *
 * @type {Map<string, { currentHash: Buffer, byParent: Map<string, Buffer> }>}
 */
const cache = new Map()
let cachedPathwayHashes = 0

const PATHWAY_CONTEXT_BYTES = 20

// Reused across `encodePathwayContext` calls; the buffer is fully rewritten before each
// `Buffer.from(...)` copy-out so callers never observe mutation between checkpoints.
const pathwayScratch = Buffer.allocUnsafe(PATHWAY_CONTEXT_BYTES)

function shaHash (checkpointString) {
  // Copy out of the 32-byte digest so the cache doesn't retain it.
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

  const joinedEdgeTags = hashableEdgeTags.join('')
  const baseString = `${service}${env}${joinedEdgeTags}`
  const hashInput = propagationHashBigInt ? `${baseString}:${propagationHashBigInt.toString(16)}` : baseString

  // The hash input excludes parentHash, which is combined with it via a second sha pass to produce the final hash.
  // A fan-in node with different parents therefore gets distinct entries under the same hash input.
  let entry = cache.get(hashInput)
  const parentKey = parentHash.toString('latin1')
  if (entry !== undefined) {
    const cached = entry.byParent.get(parentKey)
    if (cached !== undefined) {
      return cached
    }
  }

  if (cachedPathwayHashes >= MAX_CACHED_PATHWAY_HASHES) {
    cache.clear()
    cachedPathwayHashes = 0
    entry = undefined
  }

  if (entry === undefined) {
    entry = { currentHash: shaHash(hashInput), byParent: new Map() }
    cache.set(hashInput, entry)
  }

  const value = shaHash(Buffer.concat([entry.currentHash, parentHash], 16).toString())
  entry.byParent.set(parentKey, value)
  cachedPathwayHashes++
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
 * @param {string | Buffer} pathwayContext
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
   * @param {object} [carrier]
   * @returns {object | undefined}
   */
  encode (dataStreamsContext, carrier) {
    if (!dataStreamsContext || !dataStreamsContext.hash) return
    carrier ??= {}
    writeDsmBase64(carrier, encodePathwayContextBase64(dataStreamsContext))

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Injected into DSM carrier: ${JSON.stringify(pickDsm(carrier))}.`)

    return carrier
  },

  /**
   * @param {object} carrier
   * @returns {ReturnType<typeof decodePathwayContext>|undefined}
   */
  decode (carrier) {
    if (carrier == null) return

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Attempting extract from DSM carrier: ${JSON.stringify(pickDsm(carrier))}.`)

    let ctx
    if (hasDsmBase64(carrier)) {
      // decode v2 encoding of base64
      const encoded = readDsmBase64(carrier)
      if (encoded !== undefined) ctx = decodePathwayContextBase64(encoded)
    } else if (hasDsmBinary(carrier)) {
      const encoded = readDsmBinary(carrier)
      if (Buffer.isBuffer(encoded)) {
        // decode v1 encoding
        ctx = decodePathwayContext(encoded)
      }
      // cover case where base64 context was received under wrong key
      if (!ctx && encoded !== undefined) {
        ctx = decodePathwayContextBase64(encoded)
      }
    }

    return ctx
  },
}

module.exports = {
  computePathwayHash: computeHash,
  encodePathwayContext,
  decodePathwayContext,
  encodePathwayContextBase64,
  decodePathwayContextBase64,
  DsmPathwayCodec,
}
