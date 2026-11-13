'use strict'

const { addHook } = require('./helpers/instrument')
const { wrapProtocolRequest } = require('./modelcontextprotocol-sdk')

// SDK 2.x clients bundle Protocol into a chunk with a hashed name. The package entry re-exports it, so hook the entry.
addHook({ name: '@modelcontextprotocol/client', versions: ['>=2'] }, exports => {
  wrapProtocolRequest(exports.Protocol)
  return exports
})
