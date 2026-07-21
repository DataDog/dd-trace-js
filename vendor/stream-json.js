'use strict'

const { parser } = require('stream-json')
const { pick } = require('stream-json/filters/pick.js')
const { streamValues } = require('stream-json/streamers/stream-values.js')

module.exports = {
  parser: parser.asStream,
  pick: pick.asStream,
  streamValues: streamValues.asStream,
}
