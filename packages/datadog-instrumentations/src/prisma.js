'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const { storage } = require('../../datadog-core')

const prismaEngineStart = channel('apm:prisma:engine:start')
const tracingChannel = require('dc-polyfill').tracingChannel
const clientCH = tracingChannel('apm:prisma:client')

const allowedClientSpanOperations = new Set([
  'operation',
  'serialize',
  'transaction'
])

class TracingHelper {
  dbConfig = null
  isEnabled () {
    return true
  }

  // needs a sampled tracecontext to generate engine spans
  getTraceParent (context) {
    // try to get span from current async storage context
    const store = storage('legacy').getStore()
    const span = store && store.span

    if (span && typeof span.context === 'function') {
      const spanContext = span.context()
      if (spanContext && typeof spanContext.toTraceparent === 'function') {
        let traceparent = spanContext.toTraceparent()

        // force the sampled flag to '01' for Prisma's engine span generation
        // prisma only generates engine spans when the traceparent indicates the trace is sampled
        // this ensures engine spans are created and dispatched to dd-trace, which will then
        // apply its own sampling decision when recording/sending spans
        // the trace IDs and span IDs remain correct for DBM correlation
        traceparent = traceparent.replace(/-0[01]$/, '-01')

        return traceparent
      }
    }

    // fallback to a valid sampled traceparent if no active span.
    // this ensures Prisma can generate engine spans even when there's no active dd-trace context
    return '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'
  }

  dispatchEngineSpans (spans) {
    for (const span of spans) {
      if (span.parentId === null) {
        prismaEngineStart.publish({ engineSpan: span, allEngineSpans: spans, dbConfig: this.dbConfig })
      }
    }
  }

  getActiveContext () {}

  runInChildSpan (options, callback) {
    if (typeof options === 'string') {
      options = {
        name: options
      }
    }

    if (allowedClientSpanOperations.has(options.name)) {
      const ctx = {
        resourceName: options.name,
        attributes: options.attributes || {}
      }

      if (options.name !== 'serialize') {
        return clientCH.tracePromise(callback, ctx, this, ...arguments)
      }

      return clientCH.traceSync(callback, ctx, this, ...arguments)
    }
    return callback()
  }

  setDbString (dbConfig) {
    this.dbConfig = dbConfig
  }
}

addHook({ name: '@prisma/client', versions: ['>=6.1.0'] }, (prisma, version) => {
  const tracingHelper = new TracingHelper()

  // we need to patch the prototype to get db config since this works for ESM and CJS alike.
  const originalRequest = prisma.PrismaClient.prototype._request
  prisma.PrismaClient.prototype._request = function () {
    if (!tracingHelper.dbConfig) {
      const inlineDatasources = this._engine?.config.inlineDatasources
      const overrideDatasources = this._engine?.config.overrideDatasources
      const datasources = inlineDatasources?.db.url?.value ?? overrideDatasources?.db?.url
      if (datasources) {
        const result = parseDBString(datasources)
        tracingHelper.setDbString(result)
      }
    }
    return originalRequest.apply(this, arguments)
  }

  /*
    * This is taking advantage of the built in tracing support from Prisma.
    * The below variable is setting a global tracing helper that Prisma uses
    * to enable OpenTelemetry.
  */
  // https://github.com/prisma/prisma/blob/478293bbfce91e41ceff02f2a0b03bb8acbca03e/packages/instrumentation/src/PrismaInstrumentation.ts#L42
  const versions = version.split('.')
  if (versions[0] === '6' && versions[1] < 4) {
    global.PRISMA_INSTRUMENTATION = {
      helper: tracingHelper
    }
  } else {
    global[`V${versions[0]}_PRISMA_INSTRUMENTATION`] = {
      helper: tracingHelper
    }
  }

  return prisma
})

function parseDBString (dbString) {
  const url = new URL(dbString)
  const dbConfig = {
    user: url.username,
    password: url.password,
    host: url.hostname,
    port: url.port,
    database: url.pathname.slice(1) // Remove leading slash
  }
  return dbConfig
}
