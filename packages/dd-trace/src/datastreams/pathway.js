// encoding used here is FNV1a
// other languages use FNV1
// this inconsistency is ok because hashes do not need to be consistent across services
const fnv = require('fnv-plus')
const { encodeVarint, decodeVarint } = require('./encoding')
const cache = require('lru-cache')

function fnvHash (checkpointString) {
  const hash = fnv.hash(checkpointString, 64)
  return Buffer.from(hash.hex(), 'hex')
}

function computeHash (service, env, edgeTags, parentHash) {
  const key = `${service}${env}` + edgeTags.join('') + parentHash.toString()
  if (cache.has(key)) {
    return cache.get(key)
  }
  const currentHash = fnvHash(`${service}${env}` + edgeTags.join(''))
  const buf = Buffer.concat([ currentHash, parentHash ], 16)
  const val = fnvHash(buf.toString())
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

module.exports = {
  computePathwayHash: computeHash,
  encodePathwayContext,
  decodePathwayContext
}
