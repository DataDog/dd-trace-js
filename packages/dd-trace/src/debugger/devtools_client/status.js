'use strict'

const LRUCache = require('lru-cache')
const config = require('./config')
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

const cache = new LRUCache({
  ttl: 1000 * 60 * 60, // 1 hour
  // Unfortunate requirement when using LRUCache:
  // It will emit a warning unless `ttlAutopurge`, `max`, or `maxSize` is set when using `ttl`.
  // TODO: Consider alternative as this is NOT performant :(
  ttlAutopurge: true
})

const STATUSES = {
  RECEIVED: 'RECEIVED',
  INSTALLED: 'INSTALLED',
  EMITTING: 'EMITTING',
  ERROR: 'ERROR',
  BLOCKED: 'BLOCKED' // TODO: Implement once support for allow list, deny list or max probe limit has been added
}

function ackReceived ({ id: probeId, version }) {
  onlyUniqueUpdates(
    STATUSES.RECEIVED, probeId, version,
    () => send(statusPayload(probeId, version, STATUSES.RECEIVED))
  )
}

function ackInstalled ({ id: probeId, version }) {
  onlyUniqueUpdates(
    STATUSES.INSTALLED, probeId, version,
    () => send(statusPayload(probeId, version, STATUSES.INSTALLED))
  )
}

function ackEmitting ({ id: probeId, version }) {
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
  const form = new FormData()

  form.append(
    'event',
    JSON.stringify(payload),
    { filename: 'event.json', contentType: 'application/json; charset=utf-8' }
  )

  const options = {
    method: 'POST',
    url: config.url,
    path: '/debugger/v1/diagnostics',
    headers: form.getHeaders()
  }

  request(form, options, (err) => {
    if (err) log.error('[debugger:devtools_client] Error sending debugger payload', err)
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
  cache.set(key)
}
