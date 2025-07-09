'use strict'

function weakRandom () {
  return Math.random()
}

function safeRandom () {
  const { randomBytes } = require('node:crypto')
  return randomBytes(256)
}

function customRandom () {
  const Math = {
    random: function () {
      return 4 // chosen by fair dice roll - guaranteed to be random
    }
  }

  return Math.random()
}

module.exports = {
  weakRandom,
  safeRandom,
  customRandom
}
