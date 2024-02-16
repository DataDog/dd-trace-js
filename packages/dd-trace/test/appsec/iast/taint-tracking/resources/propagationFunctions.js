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

function trimProtoStr (str) {
  return String.prototype.trim.call(str)
}

function concatStr (str) {
  return str.concat(' ', 'b', 'c')
}

function concatTaintedStr (str) {
  return 'ls '.concat(' ', str, 'c')
}

function concatProtoStr (str) {
  return String.prototype.concat.call(str, ' a ', ' b ')
}

function substringStr (str) {
  return str.substring(1, 4)
}

function substrStr (str) {
  return str.substr(1, 4)
}

function sliceStr (str) {
  return str.slice(1, 4)
}

function replaceStr (str) {
  return str.replace('ls', 'sl')
}

function replaceRegexStr (str) {
  return str.replace(/ls/g, 'ls')
}

function jsonParseStr (str) {
  return JSON.parse(str)
}

module.exports = {
  concatSuffix,
  insertStr,
  appendStr,
  trimStr,
  trimStartStr,
  trimEndStr,
  trimProtoStr,
  concatStr,
  concatTaintedStr,
  concatProtoStr,
  substringStr,
  substrStr,
  sliceStr,
  replaceStr,
  replaceRegexStr,
  jsonParseStr
}
