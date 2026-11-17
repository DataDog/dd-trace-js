'use strict'

const parseTitle = (title, pattern) => {
  const match = (title || '').match(new RegExp(pattern))
  if (!match) return

  const isRevert = !match[3]
  return {
    type: isRevert ? 'revert' : match[3],
    breaking: isRevert ? match[2] === '!' : match[6] === '!',
  }
}

module.exports = { parseTitle }
