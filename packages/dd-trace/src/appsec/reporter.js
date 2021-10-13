'use strict'

const os = require('os')
const path = require('path')
const uuid = require('crypto-randomuuid')
const requirePackageJson = require('../require-package-json')
const { getContext } = require('../gateway/engine')
const Addresses = require('./addresses')
const Scheduler = require('../exporters/agent/scheduler')
const request = require('../exporters/agent/request')
const log = require('../log')

const FLUSH_INTERVAL = 2e3
const MAX_EVENT_BACKLOG = 1e6

const host = {
  context_version: '0.1.0',
  os_type: os.type(),
  hostname: os.hostname()
}

const tracer = {
  context_version: '0.1.0',
  runtime_type: 'nodejs',
  runtime_version: process.version,
  lib_version: requirePackageJson(path.join(__dirname, '..', '..', '..', '..')).version
}

const events = new Set()

function resolveHTTPAddresses () {
  const context = getContext()

  const path = context.resolve(Addresses.HTTP_INCOMING_URL)
  const headers = context.resolve(Addresses.HTTP_INCOMING_HEADERS)

  const url = new URL(path, `http://${headers.host}`)

  return {
    // scheme: context.resolve(Addresses.),
    method: context.resolve(Addresses.HTTP_INCOMING_METHOD),
    url: url.href,
    host: url.hostname,
    port: url.port, // context.resolve(Addresses.HTTP_INCOMING_PORT),
    path: url.pathname,
    // route: context.resolve(Addresses.),
    remote_ip: context.resolve(Addresses.HTTP_INCOMING_REMOTE_IP),
    remote_port: context.resolve(Addresses.HTTP_INCOMING_REMOTE_PORT),
    // responseCode: context.resolve(Addresses.),
    headers
  }
}

const HEADERS_TO_SEND = [
  'user-agent',
  'referer',
  'x-forwarded-for',
  'x-real-ip',
  'client-ip',
  'x-forwarded',
  'x-cluster-client-ip',
  'forwarded-for',
  'forwarded',
  'via'
]

function getHeadersToSend (headers) {
  const result = {}

  for (let i = 0; i < HEADERS_TO_SEND.length; ++i) {
    const headerName = HEADERS_TO_SEND[i]

    if (headers[headerName]) {
      result[headerName] = headers[headerName]
    }
  }

  return result
}

function getTracerData () {
  const scope = global._ddtrace._tracer.scope()

  const result = {
    serviceName: scope._config.service,
    serviceEnv: scope._config.env,
    serviceVersion: scope._config.version,
    tags: Object.entries(scope._config.tags).map(([k, v]) => `${k}:${v}`) // TODO: this can be optimized
  }

  const activeSpan = scope.active()

  if (activeSpan) {
    activeSpan.setTag('manual.keep')
    activeSpan.setTag('appsec.event', true)

    const context = activeSpan.context()

    result.spanId = context.toSpanId()
    result.traceId = context.toTraceId()
  }

  return result
}

function formatAttack ({
  ruleId,
  ruleName,
  ruleTags,
  matchOperator,
  matchOperatorValue,
  matchParameters,
  matchHighlight
}) {
  return {
    rule: {
      id: ruleId,
      name: ruleName,
      tags: ruleTags
    },
    rule_match: {
      operator: matchOperator,
      operator_value: matchOperatorValue,
      parameters: matchParameters,
      highlight: matchHighlight
    }
  }
}

// TODO: lock
function flush () {
  if (!events.size) return
  else if (events.size >= MAX_EVENT_BACKLOG) {
    log.warn('Dropping AppSec events because the backlog is full')
  }

  const eventsArray = Array.from(events.values())

  // if they fail to send, we drop the events
  for (let i = 0; i < eventsArray.length; ++i) {
    events.delete(eventsArray[i])
  }

  const options = {
    path: '/appsec/proxy/api/v2/appsecevts',
    method: 'POST',
    headers: {
      'X-Api-Version': 'v0.1.0',
      'Content-Type': 'application/json'
    },
    data: JSON.stringify({
      protocol_version: 1,
      idempotency_key: uuid(),
      events: eventsArray
    })
  }

  const url = global._ddtrace._tracer._exporter._writer._url

  if (url.protocol === 'unix:') {
    options.socketPath = url.pathname
  } else {
    options.protocol = url.protocol
    options.hostname = url.hostname
    options.port = url.port
  }

  request(options, (err, res, status) => {
    if (err) {
      log.error(err)
    }
  })
}

const scheduler = new Scheduler(flush, FLUSH_INTERVAL)
scheduler.start()

module.exports = {
  scheduler,
  formatAttack
}
