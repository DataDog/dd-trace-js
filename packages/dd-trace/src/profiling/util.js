'use strict'

function coalesce (...args) {
  return args.find(arg => arg !== undefined && arg !== null)
}

function maybeRequire (id) {
  try {
    return require(id)
  } catch (e) {
    return null
  }
}

module.exports = {
  coalesce,
  maybeRequire
}
