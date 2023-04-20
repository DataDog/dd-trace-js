const fnv = require('fnv-plus')
const { encodeVarint, decodeVarint } = require('../../dd-trace/src/datastreams/encoding')

// encoding used here is FNV1a
// other languages use FNV1
// this inconsistency is ok because hashes do not need to be consistent across services
function getConnectionHash (checkpointString) {
  const hash = fnv.hash(checkpointString, 64)
  return Buffer.from(hash.hex(), 'hex')
}

function getPathwayHash (checkpointString, parentHash) {
  const currentHash = getConnectionHash(checkpointString)
  const buf = Buffer.concat([ currentHash, parentHash ], 16)
  return getConnectionHash(buf.toString())
}

function encodePathwayContext (pathwayHash, timeSinceOrigin, timeSincePrev) {
  return Buffer.concat([ pathwayHash, encodeVarint(timeSinceOrigin), encodeVarint(timeSincePrev) ], 20)
}

function decodePathwayContext (pathwayContext) {
  const pathwayHash = pathwayContext.subarray(0, 8)
  const encodedTimestamps = pathwayContext.subarray(8)
  const [timeSinceOrigin, encodedTimeSincePrev] = decodeVarint(encodedTimestamps)
  const [timeSincePrev] = decodeVarint(encodedTimeSincePrev)
  return [ pathwayHash, timeSinceOrigin, timeSincePrev ]
}

module.exports = {
  getConnectionHash,
  getPathwayHash,
  encodePathwayContext,
  decodePathwayContext
}
