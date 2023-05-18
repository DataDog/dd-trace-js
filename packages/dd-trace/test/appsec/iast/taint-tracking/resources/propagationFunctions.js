function concatSuffix (str) {
  return 'ls #' + str + '_suffix'
}

function insertStr (str) {
  return 'ls #' + `pre_${str}_suf`
}

function appendStr (str) {
  let pre = 'pre_'
  pre += str
  return 'ls #' + pre
}

function trimStr (str) {
  return 'ls #' + str.trim()
}

function trimStartStr (str) {
  return 'ls #' + str.trimStart()
}

function trimEndStr (str) {
  return 'ls #' + str.trimEnd()
}

function trimProtoStr (str) {
  return 'ls #' + String.prototype.trim.call(str)
}

function concatStr (str) {
  return 'ls #' + str.concat(' ', 'b', 'c')
}

function concatTaintedStr (str) {
  return 'ls #' + 'ls '.concat(' ', str, 'c')
}

function concatProtoStr (str) {
  return 'ls #' + String.prototype.concat.call(str, ' a ', ' b ')
}

function substringStr (str) {
  return 'ls #' + str.substring(1, 4)
}

function substrStr (str) {
  return 'ls #' + str.substr(1, 4)
}

function sliceStr (str) {
  return 'ls #' + str.slice(1, 4)
}

function replaceStr (str) {
  return 'ls #' + str.replace('ls', 'sl')
}

function replaceRegexStr (str) {
  return 'ls #' + str.replace(/ls/g, 'ls')
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
  replaceRegexStr
}
