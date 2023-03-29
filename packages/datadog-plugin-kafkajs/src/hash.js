const fnv = require('fnv-plus')
const { encodeVarint, decodeVarint } = require('../../dd-trace/src/datastreams/encoding')

// converts string to buffer
function getConnectionHash (checkpointString) {
  const hash = fnv.hash(checkpointString, 64)
  return Buffer.from(hash.hex(), 'hex')
}

// const hash = fnv.hash('unnamed-go-servicetype:kafka', 64)
// console.log(hash.dec())

function getPathwayHash (checkpointString, parentHash) {
  const currentHash = getConnectionHash(checkpointString)
  const buf = Buffer.concat([ currentHash, parentHash ], 16)
  return getConnectionHash(buf.toString())
}

function encodePathwayContext (pathwayHash, timeSinceOrigin, timeSincePrev) {
  return Buffer.concat([ pathwayHash, encodeVarint(timeSinceOrigin), encodeVarint(timeSincePrev) ], 20)
}

function decodePathwayContext (pathwayContext) {
  const pathwayHash = pathwayContext.subarray(8)
  const encodedTimestamps = pathwayContext.subarray(8, 20)
  const [timeSinceOrigin, encodedTimeSincePrev] = decodeVarint(encodedTimestamps)
  const [timeSincePrev, placeHolder] = decodeVarint(encodedTimeSincePrev)
  return [ pathwayHash, timeSinceOrigin, timeSincePrev ]
}

module.exports = {
  getPathwayHash,
  encodePathwayContext,
  decodePathwayContext
}
