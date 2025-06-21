'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')

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
    return '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' // valid sampled traceparent
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

  /*
    * This is a custom PrismaClient that extends the original PrismaClient
    * This allows us to grab additional information from the PrismaClient such as DB connection strings
  */
  class PrismaClient extends prisma.PrismaClient {
    constructor (...args) {
      super(...args)

      const datasources = this._engine?.config.inlineDatasources?.db.url?.value
      if (datasources) {
        const result = parseDBString(datasources)
        tracingHelper.setDbString(result)
      }
    }
  }

  prisma.PrismaClient = PrismaClient
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
