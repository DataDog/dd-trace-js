'use strict'

function chooseBranch (value) {
  if (value === 'alpha') {
    return 'first'
  }

  return 'fallback'
}

module.exports = { chooseBranch }
