'use strict'

const START = `"signed":{`

/**
 * Extract the raw value under "signed" from a JSON string
 * the JSON string MUST be canonical, especially there MUST NOT be any spaces between literals
 * @param {string} str
 */
function extractSigned (str) {
  // let's ensure the JSON is valid
  const parsed = JSON.parse(str) // will throw an error if it is not
  if (!parsed.hasOwnProperty('signed')) throw new Error('no field \'signed\' in targets object')
  if (typeof parsed.signed !== 'object') throw new TypeError('field \'signed\' must be an object')
  if (parsed.signed === null) throw new TypeError('field \'signed\' is null')
  // let's find ${START} as a top level key
  let state = 0
  let isInString = false
  let startPosition = -1
  let stopPosition = -1
  for (let i = 0; i < str.length; ++i) {
    if (str[i] === '{') {
      ++state
      continue
    }
    if (str[i] === '}') {
      --state
      continue
    }
    if (str.startsWith(START, i) && state === 1) {
      startPosition = i + START.length - 1
      break
    }
  }
  // at this point we must have broken out of the loop as we know parsed is a top level key
  state = 0
  for (let i = startPosition; i < str.length; ++i) {
    const curr = str[i]
    if (curr === '"') {
      // TODO(@vdeturckheim): parse the string with JSON.parse to make sur we don't miss anything
      if (!isInString) {
        isInString = true
        continue
      }
      if (str[i - 1] === '\\') continue
      isInString = false
      continue
    }
    if (isInString) continue
    if (curr === '{') {
      ++state
      continue
    }
    if (curr === '}') {
      --state
    }
    if (state === 0) {
      stopPosition = i + 1
      break
    }
  }
  return str.substring(startPosition, stopPosition)
}

module.exports = {
  extractSigned
}
