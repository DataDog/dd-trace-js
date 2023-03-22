const fnv = require('fnv-plus')

function getConnectionHash (checkpointString) {
  return fnv.hash(checkpointString, 64)
}

// TODO
function getPathwayHash (parentHash, currentHash) {
  return parentHash + currentHash
}

// TODO
function encodePathwayCtx (pathwayHash, originTs, currentTs) {
  return pathwayHash + originTs + currentTs
}

module.exports = {
  getConnectionHash,
  getPathwayHash,
  encodePathwayCtx
}
