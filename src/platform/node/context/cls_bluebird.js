'use strict'

const clsBluebird = require('cls-bluebird')

module.exports = namespace => {
  try {
    clsBluebird(namespace)
  } catch (e) {
    // skip
  }
}
