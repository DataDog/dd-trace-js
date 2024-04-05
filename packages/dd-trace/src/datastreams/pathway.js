const { toBufferLE } = require('bigint-buffer')
const { encodeVarInt64, decodeVarInt64 } = require('./encoding')

const CONTEXT_PROPAGATION_KEY = 'dd-pathway-ctx'
const CONTEXT_PROPAGATION_KEY_BASE64 = 'dd-pathway-ctx-base64'

const FNV_64_PRIME = BigInt('0x100000001B3')
const FNV1_64_INIT = BigInt('0xCBF29CE484222325')

function fnv (data, hvalInit, fnvPrime, fnvSize) {
  let hval = hvalInit
  for (let i = 0; i < data.length; i++) {
    hval = (hval * fnvPrime) % fnvSize
    hval ^= BigInt(data[i])
  }
  return hval
}

function fnv1Base64 (data) {
  return fnv(data, FNV1_64_INIT, FNV_64_PRIME, 2n ** 64n)
}

function getBytes (s) {
  return Buffer.from(s, 'utf-8')
}

function computeHash (service, env, tags, parentHash) {
  let b = Buffer.concat([getBytes(service), getBytes(env)])
  for (const t of tags) {
    b = Buffer.concat([b, getBytes(t)])
  }
  const nodeHash = fnv1Base64(b)
  // console.log(node_hash)
  const nodeHashBuffer = toBufferLE(nodeHash, 8)

  const parentHashBuffer = toBufferLE(BigInt(parentHash), 8)

  const combinedBuffer = Buffer.concat([nodeHashBuffer, parentHashBuffer])
  return fnv1Base64(combinedBuffer)
}

function encodePathwayContext (dataStreamsContext) {
  return Buffer.concat([
    toBufferLE(BigInt(dataStreamsContext.hash), 8),
    encodeVarInt64(BigInt(dataStreamsContext.pathway_start_sec * 1e3)),
    encodeVarInt64(BigInt(dataStreamsContext.current_edge_start_sec * 1e3))
  ])
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
  const [pathwayStartMs, encodedTimeSincePrev] = decodeVarInt64(encodedTimestamps)
  if (pathwayStartMs === undefined) {
    return null
  }
  const [edgeStartMs] = decodeVarInt64(encodedTimeSincePrev)
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
  }

  static decode (carrier) {
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
      if (!ctx) ctx = decodePathwayContextBase64(carrier[CONTEXT_PROPAGATION_KEY])
    }
    return ctx
  }

  static contextExists (carrier) {
    return CONTEXT_PROPAGATION_KEY_BASE64 in carrier || CONTEXT_PROPAGATION_KEY in carrier
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
