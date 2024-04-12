function trimLodash (_, str) {
  return _.trim(str)
}

function trimStartLodash (_, str) {
  return _.trimStart(str)
}

function trimEndLodash (_, str) {
  return _.trimEnd(str)
}

function toLowerLodash (_, str) {
  return _.toLower(str)
}

function toUpperLodash (_, str) {
  return _.toUpper(str)
}

function arrayJoinLodashWithoutSeparator (_, str) {
  return _.join([str, str])
}

function arrayJoinLodashWithSeparator (_, str) {
  return _.join([str, str], str)
}

module.exports = {
  trimLodash,
  trimStartLodash,
  trimEndLodash,
  toLowerLodash,
  toUpperLodash,
  arrayJoinLodashWithoutSeparator,
  arrayJoinLodashWithSeparator
}
