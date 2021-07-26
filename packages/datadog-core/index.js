'use strict'

const { channel } = require('diagnostics_channel')

const debugChannel = channel('datadog/diagnostic/debug')
const infoChannel = channel('datadog/diagnostic/info')
const warningChannel = channel('datadog/diagnostic/warning')
const errorChannel = channel('datadog/diagnostic/error')

module.exports = {
  channel,
  debugChannel,
  errorChannel,
  infoChannel,
  warningChannel
}
