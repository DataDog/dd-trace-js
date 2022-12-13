function trimStr (str) {
  return str.trim()
}

function trimStartStr (str) {
  return str.trimStart()
}

function trimEndStr (str) {
  return str.trimEnd()
}

function concatSuffix (str) {
  return str + '_suffix'
}

module.exports = {
  trimStr,
  trimStartStr,
  trimEndStr,
  concatSuffix
}
