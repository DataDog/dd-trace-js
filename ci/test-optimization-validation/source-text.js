'use strict'

/**
 * Replaces JavaScript comments with spaces while preserving line structure and string literals.
 *
 * @param {string} source JavaScript or TypeScript source
 * @returns {string} source with comments masked
 */
function maskJavaScriptComments (source) {
  return maskJavaScriptSource(source, false)
}

/**
 * Replaces JavaScript comments and string literals with spaces while preserving line structure.
 *
 * @param {string} source JavaScript or TypeScript source
 * @returns {string} source with non-code text masked
 */
function maskJavaScriptNonCode (source) {
  return maskJavaScriptSource(source, true)
}

/**
 * Masks comments and optionally string literals in JavaScript-like source.
 *
 * @param {string} source JavaScript or TypeScript source
 * @param {boolean} maskStrings whether string and template literal contents should be masked
 * @returns {string} masked source
 */
function maskJavaScriptSource (source, maskStrings) {
  const characters = [...source]
  let blockComment = false
  let lineComment = false
  let quote = ''

  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]
    const next = characters[index + 1]
    if (lineComment) {
      if (character === '\n') {
        lineComment = false
      } else {
        characters[index] = ' '
      }
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        characters[index] = ' '
        characters[++index] = ' '
        blockComment = false
      } else if (character !== '\r' && character !== '\n') {
        characters[index] = ' '
      }
      continue
    }
    if (quote) {
      if (maskStrings && character !== '\r' && character !== '\n') characters[index] = ' '
      if (character.charCodeAt(0) === 92) {
        if (maskStrings && index + 1 < characters.length &&
          characters[index + 1] !== '\r' && characters[index + 1] !== '\n') {
          characters[index + 1] = ' '
        }
        index++
      } else if (character === quote) {
        quote = ''
      }
      continue
    }
    if (character === '"' || character === '\'' || character === '`') {
      quote = character
      if (maskStrings) characters[index] = ' '
    } else if (character === '/' && next === '/') {
      characters[index] = ' '
      characters[++index] = ' '
      lineComment = true
    } else if (character === '/' && next === '*') {
      characters[index] = ' '
      characters[++index] = ' '
      blockComment = true
    }
  }

  return characters.join('')
}

module.exports = { maskJavaScriptComments, maskJavaScriptNonCode }
