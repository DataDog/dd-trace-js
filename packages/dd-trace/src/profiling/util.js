'use strict'

function maybeRequire (id) {
  try {
    return require(id)
  } catch (e) {
    return null
  }
}

module.exports = {
  maybeRequire
}
