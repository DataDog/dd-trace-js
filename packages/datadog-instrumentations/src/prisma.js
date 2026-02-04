'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const { channel, addHook } = require('./helpers/instrument')
const prismaHelperInit = channel('apm:prisma:helper:init')

const prismaHook = (runtime, versions, name, isIitm) => {
  const originalGetPrismaClient = runtime.getPrismaClient

  if (!originalGetPrismaClient) return runtime

  const prismaHelperCtx = {}

  const wrappedGetPrismaClient = function (config) {
    // Prisma config shapes vary by version/runtime entrypoint. We try a few known locations
    // and fall back to DATABASE_URL when present.
    const datasourceUrl =
      config?.inlineDatasources?.db?.url?.value ??
      config?.inlineDatasources?.db?.url ??
      config?.overrideDatasources?.db?.url ??
      config?.datasources?.db?.url ??
      config?.datasourceUrl ??
      getEnvironmentVariable('DATABASE_URL')

    if (datasourceUrl && !prismaHelperCtx.dbConfig) {
      prismaHelperCtx.dbConfig = parseDBString(datasourceUrl)
    }
    prismaHelperInit.publish(prismaHelperCtx)

    const PrismaClient = originalGetPrismaClient.call(this, config)
    return class WrappedPrismaClientClass extends PrismaClient {
      constructor (clientConfig) {
        super(clientConfig)
        this._tracingHelper = prismaHelperCtx.helper
        this._engine.tracingHelper = prismaHelperCtx.helper
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
    },
  })
}

const prismaConfigs = [
  { name: '@prisma/client', versions: ['>=6.1.0 <7.0.0'], filePattern: 'runtime/library.*' },
  { name: './runtime/library.js', versions: ['>=6.1.0 <7.0.0'], file: 'runtime/library.js' },
  { name: '@prisma/client', versions: ['>=7.0.0'], filePattern: 'runtime/client.*' },
]

for (const config of prismaConfigs) {
  addHook(config, prismaHook)
}

function parseDBString (dbString) {
  const url = new URL(dbString)
  const dbConfig = {
    user: url.username,
    password: url.password,
    host: url.hostname,
    port: url.port,
    database: url.pathname.slice(1), // Remove leading slash
  }
  return dbConfig
}
