'use strict'

function weakRandom () {
  return Math.random()
}

function safeRandom () {
  const { randomBytes } = require('node:crypto')
  return randomBytes(256)
}

function customRandom () {
  // Shadowing is the subject under test: the analyzer must not report a user-defined Math.random.
  // eslint-disable-next-line sonarjs/no-globals-shadowing
  const Math = {
    random: function () {
      return 4 // chosen by fair dice roll - guaranteed to be random
    },
  }

  return Math.random()
}

module.exports = {
  weakRandom,
  safeRandom,
  customRandom,
}
