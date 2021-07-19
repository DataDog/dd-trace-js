'use strict'

// TODO: context tracking ?
// TODO: run the blocking instrumentation

let dc

try {
  dc = require('diagnostics_channel')
} finally {
  if (!dc || typeof dc.channel !== 'function') {
    dc = require('./dc_polyfill')
  }
}

module.exports = dc
