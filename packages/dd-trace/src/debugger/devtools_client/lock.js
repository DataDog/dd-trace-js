'use strict'

module.exports = () => {
  let p = null
  return async function lock () {
    const prev = p
    let resolve
    p = new Promise(_resolve => { resolve = _resolve })
    if (prev) await prev
    return resolve
  }
}
