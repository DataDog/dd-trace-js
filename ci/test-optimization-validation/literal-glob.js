'use strict'

// Dynamic extglobs, negation, character classes, and malformed braces fail closed.
function matchesLiteralGlob (filename, pattern) {
  const source = String(pattern || '').replaceAll('\\', '/').replace(/^\.\//, '')
  if (!source || /[!()[\]]/.test(source)) return false

  let expression = '^'
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === '*') {
      if (source[index + 1] === '*') {
        index++
        if (source[index + 1] === '/') {
          index++
          expression += '(?:.*/)?'
        } else {
          expression += '.*'
        }
      } else {
        expression += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      expression += '[^/]'
      continue
    }
    if (character === '{') {
      const end = source.indexOf('}', index + 1)
      if (end === -1) return false
      const alternatives = source.slice(index + 1, end).split(',')
      if (alternatives.length < 2 || alternatives.some(value => !/^[A-Za-z0-9._-]+$/.test(value))) return false
      expression += `(?:${alternatives.map(escapeRegExp).join('|')})`
      // eslint-disable-next-line sonarjs/updated-loop-counter
      index = end
      continue
    }
    expression += escapeRegExp(character)
  }
  try {
    return new RegExp(`${expression}$`).test(String(filename).replaceAll('\\', '/').replaceAll(/^\.\//g, ''))
  } catch {
    return false
  }
}

function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

module.exports = { matchesLiteralGlob }
