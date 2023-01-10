function concatSuffix (str) {
  return str + '_suffix'
}

function insertStr (str) {
  return `pre_${str}_suf`
}

function appendStr (str) {
  let pre = 'pre_'
  pre += str
  return pre
}

function trimStr (str) {
  return str.trim()
}

function trimStartStr (str) {
  return str.trimStart()
}

function trimEndStr (str) {
  return str.trimEnd()
}

module.exports = {
  concatSuffix,
  insertStr,
  appendStr,
  trimStr,
  trimStartStr,
  trimEndStr
}
