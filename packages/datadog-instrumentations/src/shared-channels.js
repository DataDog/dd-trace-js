'use strict'

const { channel } = require('dc-polyfill')

// Shared channel registry to ensure all modules use the same channel instances
const channels = {}

function getSharedChannel (name) {
  if (!channels[name]) {
    channels[name] = channel(name)
  }
  return channels[name]
}

module.exports = {
  getSharedChannel
}
