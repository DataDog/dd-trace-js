'use strict'

const MAX = 128 // TODO: make this configurable

function truncate (str) {
  if (!str) return str

  let replaced = str.replace(/\n/g, /\\n/g).replace(/\t/g, /\\t/g)
  if (replaced.length > MAX) {
    replaced = replaced.slice(0, MAX) + '...'
  }

  return replaced
}

module.exports = {
  truncate
}
