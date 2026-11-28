'use strict'

let branch
if (globalThis.lineCoverageBranch === 'first') {
  branch = 'first'
} else {
  branch = 'second'
}

module.exports = function getBranch () {
  return branch
}
