'use strict'

const { hostname: getHostname } = require('node:os')
const { stringify } = require('node:querystring')

const { version } = require('../../../../../package.json')
const TTLSet = require('../../../../../vendor/dist/ttl-set')
const request = require('../../exporters/common/request')
const FormData = require('../../exporters/common/form-data')
const { DEBUGGER_DIAGNOSTICS_V1 } = require('../constants')
const { DROPPED_REASON, EVENT_TYPE } = require('../guardrail-metrics')
const config = require('./config')
const guardrailMetrics = require('./guardrail-metrics')
const JSONBuffer = require('./json-buffer')
const log = require('./log')
const getRequestOptions = require('./request-options')
const buildTags = require('./tags')

module.exports = {
  ackReceived,
  ackInstalled,
  ackEmitting,
  ackError,
}

const ddsource = 'dd_debugger'
const service = config.service
const runtimeId = config.runtimeId
const ddtags = buildTags(config, getHostname(), version, log)

const cache = new TTLSet(60 * 60 * 1000) // 1 hour

// Diagnostics are queued separately from probe results so that large snapshots cannot starve them. Each diagnostic is
// a few hundred bytes, so this bound leaves room for thousands of pending status updates.
const MAX_QUEUE_BYTES = 1024 * 1024 // 1MB

const jsonBuffer = new JSONBuffer({
  size: config.maxTotalPayloadSize,
  maxQueueBytes: MAX_QUEUE_BYTES,
  timeout: config.dynamicInstrumentation.uploadIntervalSeconds * 1000,
  onFlush,
})

const STATUSES = {
  RECEIVED: 'RECEIVED',
  INSTALLED: 'INSTALLED',
  EMITTING: 'EMITTING',
  ERROR: 'ERROR',
  // TODO: Add BLOCKED once support for allow list, deny list or max probe limit has been added
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
      stacktrace: err.stack,
    }

    send(payload)
  })
}

function send (payload) {
  if (jsonBuffer.write(JSON.stringify(payload))) return

  const { probeId, status } = payload.debugger.diagnostics
  log.debug('[debugger:devtools_client] Dropping %s status for probe %s: diagnostics queue is full', status, probeId)
  guardrailMetrics.eventDropped(DROPPED_REASON.QUEUE_FULL, EVENT_TYPE.DIAGNOSTIC)
}

/**
 * @param {string} payload - The payload to send
 * @param {() => void} done - Releases the payload from the diagnostics queue
 */
function onFlush (payload, done) {
  log.debug('[debugger:devtools_client] Flushing diagnostics payload buffer')

  const form = new FormData()

  form.append(
    'event',
    payload,
    { filename: 'event.json', contentType: 'application/json; charset=utf-8' }
  )

  const path = config.agentless
    ? `${config.inputPath}?${stringify({ ddtags })}`
    : DEBUGGER_DIAGNOSTICS_V1
  const options = getRequestOptions(config, path, form.getHeaders())

  request(form, options, (err) => {
    done()
    if (err) log.error('[debugger:devtools_client] Error sending diagnostics payload', err)
  })
}

function statusPayload (probeId, probeVersion, status) {
  return {
    ddsource,
    service,
    debugger: {
      diagnostics: { probeId, runtimeId, probeVersion, status },
    },
  }
}

function onlyUniqueUpdates (type, id, version, fn) {
  const key = `${type}-${id}-${version}`
  if (cache.has(key)) return
  fn()
  cache.add(key)
}
