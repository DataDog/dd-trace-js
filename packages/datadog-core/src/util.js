'use strict'

const uuid = require('crypto-randomuuid')
const { dockerId } = require('./docker')
const pkg = require('./pkg')

const runtimeId = uuid()

function coalesce (...args) {
  for (const arg of args) {
    if (arg !== null && arg !== undefined) return arg
  }
}

module.exports = {
  coalesce,
  dockerId,
  pkg,
  runtimeId
}
