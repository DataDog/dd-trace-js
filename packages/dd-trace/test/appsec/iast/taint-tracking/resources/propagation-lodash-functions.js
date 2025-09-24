'use strict'

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

function startCaseLodash (_, str) {
  return _.startCase(str)
}

module.exports = {
  arrayJoinLodashWithoutSeparator,
  arrayJoinLodashWithSeparator,
  toLowerLodash,
  toUpperLodash,
  startCaseLodash,
  trimEndLodash,
  trimLodash,
  trimStartLodash
}
