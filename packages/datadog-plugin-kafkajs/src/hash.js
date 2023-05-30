const fnv = require('fnv-plus')
const { encodeVarint, decodeVarint } = require('../../dd-trace/src/datastreams/encoding')

// encoding used here is FNV1a
// other languages use FNV1
// this inconsistency is ok because hashes do not need to be consistent across services
function getConnectionHash (checkpointString) {
  const hash = fnv.hash(checkpointString, 64)
  return Buffer.from(hash.hex(), 'hex')
}

function computeHash (checkpointString, parentHash) {
  const currentHash = getConnectionHash(checkpointString)
  const buf = Buffer.concat([ currentHash, parentHash ], 16)
  return getConnectionHash(buf.toString())
}

function encodePathwayContext (pathwayHash, pathwayStartNs, edgeStartNs) {
  return Buffer.concat([ pathwayHash, encodeVarint(pathwayStartNs / 1e6), encodeVarint(edgeStartNs / 1e6) ], 20)
}

function decodePathwayContext (pathwayContext) {
  const pathwayHash = pathwayContext.subarray(0, 8)
  const encodedTimestamps = pathwayContext.subarray(8)
  const [pathwayStartMs, encodedTimeSincePrev] = decodeVarint(encodedTimestamps)
  const [edgeStartMs] = decodeVarint(encodedTimeSincePrev)
  return [ pathwayHash, pathwayStartMs * 1e6, edgeStartMs * 1e6 ]
}

module.exports = {
  getConnectionHash,
  getPathwayHash: computeHash,
  encodePathwayContext,
  decodePathwayContext
}
