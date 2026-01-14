'use strict'

const tracingChannel = require('dc-polyfill').tracingChannel

const { channel, addHook } = require('./helpers/instrument')
const prismaEngineStart = channel('apm:prisma:engine:start')
const clientCH = tracingChannel('apm:prisma:client')

const allowedClientSpanOperations = new Set([
  'operation',
  'serialize',
  'transaction'
])

class DatadogTracingHelper {
  dbConfig = null

  constructor (dbConfig = null) {
    this.dbConfig = dbConfig
  }

  isEnabled () {
    return true
  }

  // needs a sampled tracecontext to generate engine spans
  getTraceParent (context) {
    // TODO: Fix the id
    return '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' // valid sampled traceparent
  }

  dispatchEngineSpans (spans) {
    for (const span of spans) {
      if (span.parentId === null) {
        prismaEngineStart.publish({ engineSpan: span, allEngineSpans: spans, dbConfig: this.dbConfig })
      }
    }
  }

  getActiveContext () {
    // TODO: Fix context
  }

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

const prismaHook = (runtime, versions, name, isIitm) => {
  const originalGetPrismaClient = runtime.getPrismaClient

  if (!originalGetPrismaClient) return runtime
  const datadogTracingHelper = new DatadogTracingHelper()

  const wrappedGetPrismaClient = function (config) {
    const datasources = config.inlineDatasources?.db.url?.value
    if (datasources) {
      const dbConfig = parseDBString(datasources)
      datadogTracingHelper.setDbString(dbConfig)
    }

    const PrismaClient = originalGetPrismaClient.call(this, config)
    return class WrappedPrismaClientClass extends PrismaClient {
      constructor (clientConfig) {
        super(clientConfig)
        this._tracingHelper = datadogTracingHelper
        this._engine.tracingHelper = datadogTracingHelper
      }
    }
  }

  if (isIitm) {
    runtime.getPrismaClient = wrappedGetPrismaClient
    return runtime
  }

  return new Proxy(runtime, {
    get (target, prop) {
      if (prop === 'getPrismaClient') {
        return wrappedGetPrismaClient
      }
      return target[prop]
    }
  })
}

const prismaConfigs = [
  { name: '@prisma/client', versions: ['>=6.1.0 <7.0.0'], filePattern: 'runtime/library.*' },
  { name: './runtime/library.js', versions: ['>=6.1.0 <7.0.0'], file: 'runtime/library.js' },
  { name: '@prisma/client', versions: ['>=7.0.0'], filePattern: 'runtime/client.*' }
]

prismaConfigs.forEach(config => {
  addHook(config, prismaHook)
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
