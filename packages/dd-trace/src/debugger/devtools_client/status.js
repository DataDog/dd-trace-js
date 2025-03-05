'use strict'

const TTLSet = require('ttl-set')
const config = require('./config')
const JSONBuffer = require('./json-buffer')
const request = require('../../exporters/common/request')
const FormData = require('../../exporters/common/form-data')
const log = require('../../log')

module.exports = {
  ackReceived,
  ackInstalled,
  ackEmitting,
  ackError
}

const ddsource = 'dd_debugger'
const service = config.service
const runtimeId = config.runtimeId

const cache = new TTLSet(60 * 60 * 1000) // 1 hour

const jsonBuffer = new JSONBuffer({ size: config.maxTotalPayloadSize, timeout: 1000, onFlush })

const STATUSES = {
  RECEIVED: 'RECEIVED',
  INSTALLED: 'INSTALLED',
  EMITTING: 'EMITTING',
  ERROR: 'ERROR',
  BLOCKED: 'BLOCKED' // TODO: Implement once support for allow list, deny list or max probe limit has been added
}

function ackReceived ({ id: probeId, version }) {
  log.debug('[debugger:devtools_client] Queueing RECEIVED status for probe %s (version: %d)', probeId, version)

  onlyUniqueUpdates(
    STATUSES.RECEIVED, probeId, version,
    () => send(statusPayload(probeId, version, STATUSES.RECEIVED))
  )
}

function ackInstalled ({ id: probeId, version }) {
  log.debug('[debugger:devtools_client] Queueing INSTALLED status for probe %s (version: %d)', probeId, version)

  onlyUniqueUpdates(
    STATUSES.INSTALLED, probeId, version,
    () => send(statusPayload(probeId, version, STATUSES.INSTALLED))
  )
}

function ackEmitting ({ id: probeId, version }) {
  log.debug('[debugger:devtools_client] Queueing EMITTING status for probe %s (version: %d)', probeId, version)

  onlyUniqueUpdates(
    STATUSES.EMITTING, probeId, version,
    () => send(statusPayload(probeId, version, STATUSES.EMITTING))
  )
}

function ackError (err, { id: probeId, version }) {
  log.error('[debugger:devtools_client] ackError', err)

  onlyUniqueUpdates(STATUSES.ERROR, probeId, version, () => {
    const payload = statusPayload(probeId, version, STATUSES.ERROR)

    payload.debugger.diagnostics.exception = {
      type: err.code,
      message: err.message,
      stacktrace: err.stack
    }

    send(payload)
  })
}

function send (payload) {
  jsonBuffer.write(JSON.stringify(payload))
}

function onFlush (payload) {
  log.debug('[debugger:devtools_client] Flushing diagnostics payload buffer')

  const form = new FormData()

  form.append(
    'event',
    payload,
    { filename: 'event.json', contentType: 'application/json; charset=utf-8' }
  )

  const options = {
    method: 'POST',
    url: config.url,
    path: '/debugger/v1/diagnostics',
    headers: form.getHeaders()
  }

  request(form, options, (err) => {
    if (err) log.error('[debugger:devtools_client] Error sending diagnostics payload', err)
  })
}

function statusPayload (probeId, probeVersion, status) {
  return {
    ddsource,
    service,
    debugger: {
      diagnostics: { probeId, runtimeId, probeVersion, status }
    }
  }
}

function onlyUniqueUpdates (type, id, version, fn) {
  const key = `${type}-${id}-${version}`
  if (cache.has(key)) return
  fn()
  cache.add(key)
}
