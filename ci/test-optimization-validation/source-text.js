'use strict'

/**
 * Replaces JavaScript comments with spaces while preserving line structure and string literals.
 *
 * @param {string} source JavaScript or TypeScript source
 * @returns {string} source with comments masked
 */
function maskJavaScriptComments (source) {
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
      if (character.charCodeAt(0) === 92) {
        index++
      } else if (character === quote) {
        quote = ''
      }
      continue
    }
    if (character === '"' || character === '\'' || character === '`') {
      quote = character
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

module.exports = { maskJavaScriptComments }
