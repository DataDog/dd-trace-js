'use strict'

/**
 * Partition this file's declarations without synthetic skips or callback changes.
 *
 * @param {Function} nativeIt Mocha's original declaration function
 * @param {string} [shard] one-based shard selection, for example 1/8
 * @returns {Function}
 */
module.exports = function createExclusionsShard (nativeIt, shard = process.env.CYPRESS_EXCLUSIONS_SHARD) {
  if (shard === undefined || shard === '') return nativeIt
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard)
  const selected = match && Number(match[1])
  const count = match && Number(match[2])
  if (!Number.isSafeInteger(selected) || !Number.isSafeInteger(count) || selected > count) {
    throw new Error(`Invalid Cypress exclusions shard ${shard}: expected N/T with 1 <= N <= T`)
  }
  if (count === 1) return nativeIt
  let ordinal = 0
  const declare = (declaration, receiver, args) => {
    if (ordinal++ % count === selected - 1) return Reflect.apply(declaration, receiver, args)
  }
  const it = function (...args) { return declare(nativeIt, this, args) }
  it.skip = function (...args) { return declare(nativeIt.skip, this, args) }
  return it
}
