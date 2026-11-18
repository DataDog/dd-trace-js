'use strict'

// Pathway hashes must equal dd-trace-java's for the same checkpoint, so a pathway that crosses
// tracers resolves to one set of nodes. The rules below mirror dd-trace-java's BaseHash and
// DataStreamsTags (node hash) and DefaultPathwayContext#generatePathwayHash (pathway hash).
const { LRUCache } = require('../../../../vendor/dist/lru-cache')
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
const { writeFnv64LE } = require('./fnv')

const cache = new LRUCache({ max: 500 })
const seeds = new LRUCache({ max: 100 })
let nextSeedId = 0
/** @type {{ id: number, state: Buffer } | undefined} */
let lastSeed
/** @type {unknown[]} */
let lastSeedInputs = []

// dd-trace-java hashes these tag keys in this order, not alphabetically. Keys it does not know are
// hashed after them, alphabetically.
const HASHED_TAG_RANK = new Map([
  ['bus', 0],
  ['direction', 1],
  ['exchange', 2],
  ['topic', 3],
  ['type', 4],
  ['subscription', 5],
  ['kafka_cluster_id', 6],
])
const UNKNOWN_TAG_RANK = HASHED_TAG_RANK.size

// dd-trace-java reports these tags but keeps them out of the pathway hash.
const UNHASHED_TAG_KEYS = new Set([
  'ds.name',
  'ds.namespace',
  'manual_checkpoint',
  'group',
  'consumer_group',
  'partition',
  'has_routing_key',
])

const PATHWAY_CONTEXT_BYTES = 20

// Reused across `encodePathwayContext` calls; the buffer is fully rewritten before each
// `Buffer.from(...)` copy-out so callers never observe mutation between checkpoints.
const pathwayScratch = Buffer.allocUnsafe(PATHWAY_CONTEXT_BYTES)

/**
 * @param {string} tag
 */
function tagKey (tag) {
  const colon = tag.indexOf(':')
  return colon === -1 ? tag : tag.slice(0, colon)
}

/**
 * @param {string} tag
 */
function tagRank (tag) {
  return HASHED_TAG_RANK.get(tagKey(tag)) ?? UNKNOWN_TAG_RANK
}

/**
 * @param {string[]} sortedEdgeTags
 */
function hashedEdgeTags (sortedEdgeTags) {
  return sortedEdgeTags
    .filter(tag => !UNHASHED_TAG_KEYS.has(tagKey(tag)))
    .sort((a, b) => tagRank(a) - tagRank(b))
    .join('')
}

/**
 * Like dd-trace-java's BaseHash, the FNV state over service, env, process tags and container tags
 * hash is computed once per distinct value and continued for every checkpoint. `id` stands in for
 * that value in the checkpoint cache key; ids are never reused, so an evicted seed cannot alias another.
 *
 * @param {string} service
 * @param {string | undefined} env
 * @param {string | undefined} processTags
 * @param {string | null | undefined} containerTagsHash
 * @returns {{ id: number, state: Buffer }}
 */
function nodeHashSeed (service, env, processTags, containerTagsHash) {
  if (
    lastSeed !== undefined &&
    lastSeedInputs[0] === service &&
    lastSeedInputs[1] === env &&
    lastSeedInputs[2] === processTags &&
    lastSeedInputs[3] === containerTagsHash
  ) {
    return lastSeed
  }
  // dd-trace-java folds the container tags hash only when it folds process tags.
  const prefix = processTags
    ? `${service}${env ?? ''}${processTags}${containerTagsHash || ''}`
    : `${service}${env ?? ''}`
  let seed = seeds.get(prefix)
  if (seed === undefined) {
    const state = Buffer.alloc(8)
    writeFnv64LE(Buffer.from(prefix, 'utf8'), state, 0)
    seed = { id: nextSeedId++, state }
    seeds.set(prefix, seed)
  }
  lastSeedInputs = [service, env, processTags, containerTagsHash]
  lastSeed = seed
  return seed
}

/**
 * Sorts `edgeTags` in place.
 *
 * Returns one Buffer instance per distinct set of arguments while it stays cached: StatsBucket keys
 * stats points by that instance, which keeps tags left out of the hash, such as `group`, in separate
 * stats points.
 *
 * @param {string} service
 * @param {string | undefined} env
 * @param {string[]} edgeTags
 * @param {Buffer} parentHash Parent pathway hash as uint64 little-endian.
 * @param {string} [processTags] Serialized process tags; omitted when process tags are off.
 * @param {string | null} [containerTagsHash] Container tags hash from the agent.
 * @returns {Buffer} Pathway hash as uint64 little-endian.
 */
function computeHash (service, env, edgeTags, parentHash, processTags, containerTagsHash) {
  edgeTags.sort()
  const seed = nodeHashSeed(service, env, processTags, containerTagsHash)
  const key = `${seed.id}\0${edgeTags.join('\0')}\0${parentHash.toString('hex')}`

  let value = cache.get(key)
  if (value) {
    return value
  }

  const pathwayInput = Buffer.alloc(16)
  writeFnv64LE(Buffer.from(hashedEdgeTags(edgeTags), 'utf8'), pathwayInput, 0, seed.state)
  parentHash.copy(pathwayInput, 8)
  value = Buffer.allocUnsafe(8)
  writeFnv64LE(pathwayInput, value, 0)
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
