'use strict'

function run () {
  /* eslint-disable no-unused-vars */
  const undef = undefined
  const nil = null
  const bool = true
  const num = 42
  const bigint = BigInt(Number.MAX_SAFE_INTEGER) * 2n
  const str = 'foo'
  const sym = Symbol('foo')
  /* eslint-enable no-unused-vars */
  return 'my return value' // breakpoint at this line
}

module.exports = { run }
