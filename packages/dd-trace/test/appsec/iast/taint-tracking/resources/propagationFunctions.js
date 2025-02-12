'use strict'

function concatSuffix (str) {
  return str + '_suffix'
}

function insertStr (str) {
  return `pre_${str}_suf`
}

function templateLiteralEndingWithNumberParams (str) {
  const num1 = 1
  const num2 = 2
  return `${str}Literal${num1}${num2}`
}

function templateLiteralWithTaintedAtTheEnd (str) {
  const num1 = 1
  const num2 = 2
  const hello = 'world'
  return `Literal${num1}${num2}-${hello}-${str}`
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

function toLowerCaseStr (str) {
  return str.toLowerCase()
}

function toUpperCaseStr (str) {
  return str.toUpperCase()
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

function arrayJoin (str) {
  return [str, str].join(str)
}

function arrayInVariableJoin (str) {
  const testArr = [str, str]
  return testArr.join(',')
}

function arrayProtoJoin (str) {
  return Array.prototype.join.call([str, str], ',')
}

module.exports = {
  appendStr,
  arrayInVariableJoin,
  arrayJoin,
  arrayProtoJoin,
  concatProtoStr,
  concatStr,
  concatSuffix,
  concatTaintedStr,
  insertStr,
  jsonParseStr,
  replaceRegexStr,
  replaceStr,
  sliceStr,
  substrStr,
  substringStr,
  templateLiteralEndingWithNumberParams,
  templateLiteralWithTaintedAtTheEnd,
  toLowerCaseStr,
  toUpperCaseStr,
  trimEndStr,
  trimProtoStr,
  trimStartStr,
  trimStr
}
