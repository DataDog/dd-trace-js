// encoding used here is sha256
// other languages use FNV1
// this inconsistency is ok because hashes do not need to be consistent across services
const crypto = require('crypto')
const { encodeVarint, decodeVarint } = require('./encoding')
const LRUCache = require('lru-cache')
const log = require('../log')
const pick = require('../../../datadog-core/src/utils/src/pick')

const options = { max: 500 }
const cache = new LRUCache(options)

const CONTEXT_PROPAGATION_KEY = 'dd-pathway-ctx'
const CONTEXT_PROPAGATION_KEY_BASE64 = 'dd-pathway-ctx-base64'

const logKeys = [CONTEXT_PROPAGATION_KEY, CONTEXT_PROPAGATION_KEY_BASE64]

function shaHash (checkpointString) {
  const hash = crypto.createHash('md5').update(checkpointString).digest('hex').slice(0, 16)
  return Buffer.from(hash, 'hex')
}

function computeHash (service, env, edgeTags, parentHash) {
  edgeTags.sort()
  const hashableEdgeTags = edgeTags.filter(item => item !== 'manual_checkpoint:true')

  const key = `${service}${env}` + hashableEdgeTags.join('') + parentHash.toString()
  if (cache.get(key)) {
    return cache.get(key)
  }
  const currentHash = shaHash(`${service}${env}` + hashableEdgeTags.join(''))
  const buf = Buffer.concat([currentHash, parentHash], 16)
  const val = shaHash(buf.toString())
  cache.set(key, val)
  return val
}

function encodePathwayContext (dataStreamsContext) {
  return Buffer.concat([
    dataStreamsContext.hash,
    Buffer.from(encodeVarint(Math.round(dataStreamsContext.pathwayStartNs / 1e6))),
    Buffer.from(encodeVarint(Math.round(dataStreamsContext.edgeStartNs / 1e6)))
  ], 20)
}

function encodePathwayContextBase64 (dataStreamsContext) {
  const encodedPathway = encodePathwayContext(dataStreamsContext)
  return encodedPathway.toString('base64')
}

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

class DsmPathwayCodec {
  // we use a class for encoding / decoding in case we update our encoding/decoding. A class will make updates easier
  // instead of using individual functions.
  static encode (dataStreamsContext, carrier) {
    if (!dataStreamsContext || !dataStreamsContext.hash) {
      return
    }
    carrier[CONTEXT_PROPAGATION_KEY_BASE64] = encodePathwayContextBase64(dataStreamsContext)

    log.debug(() => `Injected into DSM carrier: ${JSON.stringify(pick(carrier, logKeys))}.`)
  }

  static decode (carrier) {
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
  }
}

module.exports = {
  computePathwayHash: computeHash,
  encodePathwayContext,
  decodePathwayContext,
  encodePathwayContextBase64,
  decodePathwayContextBase64,
  DsmPathwayCodec
}
