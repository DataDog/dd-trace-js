'use strict'

module.exports = () => async function lock () {
  if (lock.p) await lock.p
  let resolve
  lock.p = new Promise((_resolve) => { resolve = _resolve }).then(() => { lock.p = null })
  return resolve
}
