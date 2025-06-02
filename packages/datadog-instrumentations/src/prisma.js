'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')

const primsaClientStartCH = channel('apm:prisma:client:start')
const primsaClientFinishCH = channel('apm:prisma:client:finish')
const prismaClientErrorCH = channel('apm:prisma:client:error')

const prismaEngineStart = channel('apm:prisma:engine:start')

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
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      const ctx = {
        resourceName: options.name,
        attributes: options.attributes || {}
      }

      return asyncResource.runInAsyncScope(() => {
        if (!primsaClientStartCH.hasSubscribers) {
          return callback.apply(this, ctx)
        }
        primsaClientStartCH.publish(ctx)
        try {
          const result = callback.apply(this, ctx)
          if (typeof result?.then === 'function') {
            result.catch((error) => {
              prismaClientErrorCH.publish({ error, ctx })
              throw error
            })
              .finally(() => {
                if (primsaClientFinishCH.hasSubscribers) {
                  primsaClientFinishCH.publish()
                }
              })
          } else {
            if (primsaClientFinishCH.hasSubscribers) {
              primsaClientFinishCH.publish()
            }
          }
          return result
        } catch (error) {
          prismaClientErrorCH.publish({ error, ctx })
          throw error
        }
      })
    }
    return callback()
  }

  setDbString (dbConfig) {
    this.dbConfig = dbConfig
  }
}

// Tracing support GA in  v6.1.0+
// https://github.com/prisma/prisma/releases/tag/6.1.0
addHook({ name: '@prisma/client', versions: ['>=6.1.0'] }, prisma => {
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
    * This is taking advantage of the built in tracing support in Prisma.
    * This is done by setting a global tacing helper that Prisma uses
    * throuthout the Prisma codebase
  */
  // https://github.com/prisma/prisma/blob/478293bbfce91e41ceff02f2a0b03bb8acbca03e/packages/instrumentation/src/PrismaInstrumentation.ts#L42
  global.PRISMA_INSTRUMENTATION = {
    helper: tracingHelper
  }

  global.V0_PRISMA_INSTRUMENTATION = {
    helper: tracingHelper
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
