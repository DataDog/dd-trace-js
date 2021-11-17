'use strict'

const os = require('os')
const uuid = require('crypto-randomuuid')
const { getContext } = require('../gateway/engine')
const addresses = require('./addresses')
const Scheduler = require('../exporters/agent/scheduler')
const request = require('../exporters/agent/request')
const log = require('../log')
const libVersion = require('../../lib/version')

const FLUSH_INTERVAL = 2e3
const MAX_EVENT_BACKLOG = 1e6

const host = {
  context_version: '0.1.0',
  os_type: os.type(),
  hostname: os.hostname()
}

const library = {
  context_version: '0.1.0',
  runtime_type: 'nodejs',
  runtime_version: process.version,
  lib_version: libVersion
}

const events = new Set()

function resolveHTTPAddresses () {
  const context = getContext()

  if (!context) return {}

  const path = context.resolve(addresses.HTTP_INCOMING_URL)
  const headers = context.resolve(addresses.HTTP_INCOMING_HEADERS)

  // TODO: should we really hardcode the url like that ?
  const url = new URL(path, `http://${headers.host}`)

  return {
    method: context.resolve(addresses.HTTP_INCOMING_METHOD),
    url: url.href.split('?')[0],
    // route: context.resolve(addresses.HTTP_INCOMING_ROUTE),
    remote_ip: context.resolve(addresses.HTTP_INCOMING_REMOTE_IP),
    remote_port: context.resolve(addresses.HTTP_INCOMING_REMOTE_PORT),
    headers: getHeadersToSend(headers)
    // responseCode: context.resolve(addresses.HTTP_OUTGOING_STATUS),
    // responseHeaders: context.resolve(addresses.HTTP_OUTGOING_HEADERS)
  }
}

const HEADERS_TO_SEND = [
  'client-ip',
  'forwarded-for',
  'forwarded',
  'referer',
  'true-client-ip',
  'user-agent',
  'via',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-forwarded-for',
  'x-forwarded',
  'x-real-ip'
]

function getHeadersToSend (headers) {
  const result = {}

  if (!headers) return result

  for (let i = 0; i < HEADERS_TO_SEND.length; ++i) {
    const headerName = HEADERS_TO_SEND[i]

    if (headers[headerName]) {
      result[headerName] = [ headers[headerName] ]
    }
  }

  return result
}

function getTracerData () {
  const tracer = global._ddtrace._tracer

  const result = {
    serviceName: tracer._service,
    serviceEnv: tracer._env,
    serviceVersion: tracer._version,
    tags: Object.entries(tracer._tags).map(([k, v]) => `${k}:${v}`)
  }

  const activeSpan = tracer.scope().active()

  if (activeSpan) {
    activeSpan.setTag('manual.keep')
    activeSpan.setTag('appsec.event', true)

    const context = activeSpan.context()

    result.spanId = context.toSpanId()
    result.traceId = context.toTraceId()
  }

  return result
}

function reportAttack (rule, ruleMatch, blocked) {
  if (events.size > MAX_EVENT_BACKLOG) return

  const resolvedHttp = resolveHTTPAddresses()

  const tracerData = getTracerData()

  // TODO: check if some contextes could be empty
  const event = {
    event_id: uuid(),
    event_type: 'appsec',
    event_version: '1.0.0',
    detected_at: (new Date()).toJSON(),
    rule,
    rule_match: ruleMatch,
    context: {
      host,
      http: {
        context_version: '1.0.0',
        request: {
          method: resolvedHttp.method,
          url: resolvedHttp.url,
          resource: resolvedHttp.route,
          remote_ip: resolvedHttp.remote_ip,
          remote_port: resolvedHttp.remote_port,
          headers: resolvedHttp.headers
        }/* ,
        response: {
          status: resolvedHttp.responseCode,
          headers: resolvedHttp.responseHeaders,
          blocked
        } */
      },
      library,
      service: {
        context_version: '0.1.0',
        name: tracerData.serviceName,
        environment: tracerData.serviceEnv,
        version: tracerData.serviceVersion
      },
      span: {
        context_version: '0.1.0',
        id: tracerData.spanId
      },
      tags: {
        context_version: '0.1.0',
        values: tracerData.tags
      },
      trace: {
        context_version: '0.1.0',
        id: tracerData.traceId
      }
    }
  }

  events.add(event)

  return event
}

let lock = false

function flush () {
  if (lock || !events.size) return false

  if (events.size >= MAX_EVENT_BACKLOG) {
    log.warn('Dropping AppSec events because the backlog is full')
  }

  const eventsArray = Array.from(events)

  // if they fail to send, we drop the events
  for (let i = 0; i < eventsArray.length; ++i) {
    events.delete(eventsArray[i])
  }

  const options = {
    path: '/appsec/proxy/api/v2/appsecevts',
    method: 'POST',
    headers: {
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

  lock = true

  return request(options, (err, res, status) => {
    lock = false

    if (err) {
      log.error(err)
    }
  })
}

const scheduler = new Scheduler(flush, FLUSH_INTERVAL)

module.exports = {
  events,
  resolveHTTPAddresses,
  getHeadersToSend,
  getTracerData,
  reportAttack,
  flush,
  scheduler
}
