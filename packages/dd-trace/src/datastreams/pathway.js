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
 * @typedef {object} PathwayHashEntry
 * @property {Buffer} currentHash - Hash of the service, env, edge tags and propagation hash of the node.
 * @property {Map<string, Buffer>} byParent - Final hashes keyed losslessly by the parent's bytes, so distinct parent
 *   hashes never share an entry.
 */

/**
 * Trie keyed on the components that make up the hash input: service, env, each hashable edge tag in sorted order and
 * finally the propagation hash. A cache hit walks it without building a key string, so the per-checkpoint strings
 * are never flattened and hashed. It keys more finely than the hash input (for example `['ab', 'c']` and
 * `['a', 'bc']` get separate leaves), so two inputs whose hashes differ never share a leaf.
 *
 * @type {Map<unknown, Map<unknown, unknown>>}
 */
const cache = new Map()
let cachedPathwayHashes = 0

// Stands for an absent (null or zero) propagation hash. A symbol cannot equal an edge tag or a bigint.
const NO_PROPAGATION_HASH = Symbol('noPropagationHash')

const MANUAL_CHECKPOINT_TAG = 'manual_checkpoint:true'

const PATHWAY_CONTEXT_BYTES = 20

// Reused across `encodePathwayContext` calls; the buffer is fully rewritten before each
// `Buffer.from(...)` copy-out so callers never observe mutation between checkpoints.
const pathwayScratch = Buffer.allocUnsafe(PATHWAY_CONTEXT_BYTES)

function shaHash (checkpointString) {
  // Copy out of the 32-byte digest so the cache doesn't retain it.
  return Buffer.from(crypto.createHash('sha256').update(checkpointString).digest().subarray(0, 8))
}

/** @param {string[]} edgeTags */
function isSortedStrings (edgeTags) {
  for (let i = 0; i < edgeTags.length; i++) {
    if (typeof edgeTags[i] !== 'string') return false
  }
  for (let i = 1; i < edgeTags.length; i++) {
    if (edgeTags[i - 1] > edgeTags[i]) return false
  }
  return true
}

/**
 * @param {string} service
 * @param {string} env
 * @param {string[]} edgeTags
 * @param {Buffer} parentHash
 * @param {bigint | null} propagationHashBigInt - Optional propagation hash for process/container tags
 */
function computeHash (service, env, edgeTags, parentHash, propagationHashBigInt = null) {
  // Default `sort()` orders all-string arrays by UTF-16 code units, like `<`, so skipping it on an array that is
  // already sorted leaves the same array.
  if (!isSortedStrings(edgeTags)) {
    edgeTags.sort()
  }

  const propagationKey = propagationHashBigInt || NO_PROPAGATION_HASH
  const parentKey = parentHash.toString('latin1')

  let node = cache.get(service)?.get(env)
  for (let i = 0; node !== undefined && i < edgeTags.length; i++) {
    const tag = edgeTags[i]
    if (tag !== MANUAL_CHECKPOINT_TAG) {
      node = node.get(tag)
    }
  }
  /** @type {PathwayHashEntry | undefined} */
  let entry = node?.get(propagationKey)
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
    const hashableEdgeTags = edgeTags.includes(MANUAL_CHECKPOINT_TAG)
      ? edgeTags.filter(item => item !== MANUAL_CHECKPOINT_TAG)
      : edgeTags
    const baseString = `${service}${env}${hashableEdgeTags.join('')}`
    const hashInput = propagationHashBigInt ? `${baseString}:${propagationHashBigInt.toString(16)}` : baseString

    // The hash input excludes parentHash, which is combined with it via a second sha pass to produce the final hash.
    // A fan-in node with different parents therefore gets distinct entries under the same hash input.
    entry = { currentHash: shaHash(hashInput), byParent: new Map() }
    let leaf = getOrCreate(getOrCreate(cache, service), env)
    for (const tag of hashableEdgeTags) {
      leaf = getOrCreate(leaf, tag)
    }
    leaf.set(propagationKey, entry)
  }

  const value = shaHash(Buffer.concat([entry.currentHash, parentHash], 16).toString())
  entry.byParent.set(parentKey, value)
  cachedPathwayHashes++
  return value
}

/**
 * @param {Map<unknown, unknown>} map
 * @param {unknown} key
 * @returns {Map<unknown, unknown>}
 */
function getOrCreate (map, key) {
  let child = map.get(key)
  if (child === undefined) {
    child = new Map()
    map.set(key, child)
  }
  return child
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

// Consecutive messages of one producer batch share the hash and the pathway start, and the edge start is a
// millisecond timestamp, so they usually encode to the same string. The encoding is a pure function of the hash bytes
// and the two rounded millisecond values, which is what the memo is keyed on.
let lastEncodedHashLow
let lastEncodedHashHigh
let lastEncodedPathwayStartMs
let lastEncodedEdgeStartMs
let lastEncodedBase64

/**
 * @param {object} dataStreamsContext
 * @param {Buffer} dataStreamsContext.hash
 * @param {number} dataStreamsContext.pathwayStartNs
 * @param {number} dataStreamsContext.edgeStartNs
 */
function encodePathwayContextBase64 (dataStreamsContext) {
  const { hash } = dataStreamsContext
  if (!Buffer.isBuffer(hash) || hash.length !== 8) {
    return encodePathwayContext(dataStreamsContext).toString('base64')
  }
  const pathwayStartMs = Math.round(dataStreamsContext.pathwayStartNs / 1e6)
  const edgeStartMs = Math.round(dataStreamsContext.edgeStartNs / 1e6)
  const hashLow = hash.readUInt32LE(0)
  const hashHigh = hash.readUInt32LE(4)
  if (
    hashLow !== lastEncodedHashLow ||
    hashHigh !== lastEncodedHashHigh ||
    pathwayStartMs !== lastEncodedPathwayStartMs ||
    edgeStartMs !== lastEncodedEdgeStartMs
  ) {
    lastEncodedBase64 = encodePathwayContext(dataStreamsContext).toString('base64')
    lastEncodedHashLow = hashLow
    lastEncodedHashHigh = hashHigh
    lastEncodedPathwayStartMs = pathwayStartMs
    lastEncodedEdgeStartMs = edgeStartMs
  }
  return lastEncodedBase64
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

// Consecutive messages of one producer batch carry the same base64 context, and decoding is a pure function of it.
let lastDecodedBase64
/** @type {ReturnType<typeof decodePathwayContext> | undefined} */
let lastDecodedContext

/**
 * The returned `hash` may be shared between calls; do not mutate it.
 *
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
  if (typeof pathwayContext !== 'string') {
    return decodePathwayContext(Buffer.from(pathwayContext, 'base64'))
  }
  if (pathwayContext !== lastDecodedBase64) {
    lastDecodedContext = decodePathwayContext(Buffer.from(pathwayContext, 'base64'))
    lastDecodedBase64 = pathwayContext
  }
  // A fresh object per call, so a caller mutating its context cannot affect the next message.
  return lastDecodedContext && {
    hash: lastDecodedContext.hash,
    pathwayStartNs: lastDecodedContext.pathwayStartNs,
    edgeStartNs: lastDecodedContext.edgeStartNs,
  }
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
