'use strict'

const log = require('../log')
const startupLog = require('../startup-log')
const FlareFile = require('./file')
const { LogChannel } = require('../log/channels')
const request = require('../exporters/common/request')
const FormData = require('../exporters/common/form-data')

const MAX_LOG_SIZE = 12 * 1024 * 1024 // 12MB soft limit
const TIMEOUT = 20 * 1000 * 60

let logChannel = null
let tracerLogs = null
let timer
let tracerConfig = null

const logger = {
  debug: (msg) => recordLog(msg),
  info: (msg) => recordLog(msg),
  warn: (msg) => recordLog(msg),
  error: (err) => recordLog(err.stack)
}

const flare = {
  enable (tracerConfig_) {
    tracerConfig = tracerConfig_
  },

  disable () {
    tracerConfig = null

    flare.cleanup()
  },

  prepare (logLevel) {
    if (!tracerConfig) return

    logChannel?.unsubscribe(logger)
    logChannel = new LogChannel(logLevel)
    logChannel.subscribe(logger)
    tracerLogs = tracerLogs || new FlareFile()
    timer = timer || setTimeout(flare.cleanup, TIMEOUT)
  },

  send (task) {
    if (!tracerConfig) return

    const tracerInfo = new FlareFile()

    tracerInfo.write(JSON.stringify(startupLog.tracerInfo(), null, 2))

    flare._sendFile(task, tracerInfo, 'tracer_info.txt')
    flare._sendFile(task, tracerLogs, 'tracer_logs.txt')

    flare.cleanup()
  },

  cleanup () {
    logChannel?.unsubscribe(logger)
    timer = clearTimeout(timer)
    logChannel = null
    tracerLogs = null
  },

  _sendFile (task, file, filename) {
    if (!file) return

    const form = new FormData()

    form.append('case_id', task.case_id)
    form.append('hostname', task.hostname)
    form.append('email', task.user_handle)
    form.append('source', 'tracer_nodejs')
    form.append('flare_file', file.data, { filename })

    request(form, {
      url: tracerConfig.url,
      hostname: tracerConfig.hostname,
      port: tracerConfig.port,
      method: 'POST',
      path: '/tracer_flare/v1',
      headers: form.getHeaders()
    }, (err) => {
      if (err) {
        log.error(err)
      }
    })
  }
}

function recordLog (msg) {
  if (tracerLogs.length > MAX_LOG_SIZE) return

  tracerLogs.write(`${msg}\n`) // TODO: gzip
}

module.exports = flare
