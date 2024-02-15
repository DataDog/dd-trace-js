function trimLodash (_, str) {
  return _.trim(str)
}

function trimStartLodash (_, str) {
  return _.trimStart(str)
}

function trimEndLodash (_, str) {
  return _.trimEnd(str)
}

module.exports = {
  trimLodash,
  trimStartLodash,
  trimEndLodash
}
