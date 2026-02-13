'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const { channel, addHook } = require('./helpers/instrument')
const prismaHelperInit = channel('apm:prisma:helper:init')

/**
 * @typedef {object} EnvValue
 * @property {string|undefined} [value]
 * @property {string|null|undefined} [fromEnvVar]
 */

/**
 * @typedef {object} DatasourceConfig
 * @property {string|EnvValue|undefined} [url]
 */

/**
 * @typedef {object} PrismaRuntimeConfig
 * @property {Record<string, DatasourceConfig>|undefined} [inlineDatasources]
 * @property {Record<string, { url?: string }>|undefined} [overrideDatasources]
 * @property {Record<string, { url?: string }>|undefined} [datasources]
 * @property {string[]|undefined} [datasourceNames]
 */

/**
 * @typedef {object} DbConfig
 * @property {string|undefined} [user]
 * @property {string|undefined} [password]
 * @property {string|undefined} [host]
 * @property {string|number|undefined} [port]
 * @property {string|undefined} [database]
 */

/**
 * @typedef {object} AdapterConfig
 * @property {string|undefined} [connectionString]
 * @property {string|undefined} [user]
 * @property {string|undefined} [password]
 * @property {string|undefined} [host]
 * @property {string|number|undefined} [port]
 * @property {string|undefined} [database]
 */

/**
 * @typedef {object} Adapter
 * @property {AdapterConfig|undefined} [config]
 * @property {{ options?: AdapterConfig }|undefined} [externalPool]
 */

/**
 * @typedef {object} PrismaClientConfig
 * @property {string|undefined} [datasourceUrl]
 * @property {Record<string, { url?: string }>|undefined} [datasources]
 * @property {Adapter|undefined} [adapter]
 */

/**
 * @typedef {object} PrismaHelperCtx
 * @property {DbConfig} [dbConfig]
 * @property {import('../../datadog-plugin-prisma/src/datadog-tracing-helper')} [helper]
 */

/**
 * @param {string|EnvValue|undefined} envValue
 * @returns {string|undefined}
 */
function resolveEnvValue (envValue) {
  return typeof envValue === 'object' && envValue
    ? (envValue.value || getEnvironmentVariable(envValue.fromEnvVar ?? ''))
    : envValue
}

/**
 * @param {PrismaRuntimeConfig|undefined} config
 * @param {string} datasourceName
 * @returns {string|undefined}
 */
function resolveDatasourceUrl (config, datasourceName) {
  return resolveEnvValue(config?.inlineDatasources?.[datasourceName]?.url) ??
    config?.overrideDatasources?.[datasourceName]?.url ??
    config?.datasources?.[datasourceName]?.url ??
    getEnvironmentVariable('DATABASE_URL')
}

/**
 * @param {DbConfig} dbConfig
 * @returns {DbConfig|undefined}
 */
function normalizeDbConfig (dbConfig) {
  dbConfig.port = dbConfig.port == null ? undefined : String(dbConfig.port)
  const hasValues = dbConfig.user || dbConfig.password || dbConfig.host || dbConfig.port || dbConfig.database
  return hasValues ? dbConfig : undefined
}

/**
 * @param {Adapter|undefined} adapter
 * @returns {DbConfig|undefined}
 */
function resolveAdapterDbConfig (adapter) {
  const adapterConfig = adapter?.config || adapter?.externalPool?.options
  if (!adapterConfig) {
    return
  }

  if (typeof adapterConfig === 'string') {
    return parseDBString(adapterConfig)
  }

  const parsed = parseDBString(adapterConfig.connectionString)
  if (parsed) {
    return parsed
  }

  return normalizeDbConfig({
    user: adapterConfig.user,
    password: adapterConfig.password,
    host: adapterConfig.host,
    port: adapterConfig.port,
    database: adapterConfig.database,
  })
}

/**
 * @param {PrismaClientConfig|undefined} clientConfig
 * @param {string} datasourceName
 * @param {DbConfig|undefined} runtimeDbConfig
 * @returns {DbConfig|undefined}
 */
function resolveClientDbConfig (clientConfig, datasourceName, runtimeDbConfig) {
  return resolveAdapterDbConfig(clientConfig?.adapter) ||
    parseDBString(clientConfig?.datasources?.[datasourceName]?.url ?? clientConfig?.datasourceUrl) ||
    runtimeDbConfig
}

/**
 * @param {unknown} runtime
 * @param {string} versions
 * @param {string} [name]
 * @param {boolean} [isIitm]
 * @returns {object}
 */
const prismaHook = (runtime, versions, name, isIitm) => {
  /**
   * @typedef {{ getPrismaClient?: (config: PrismaRuntimeConfig, ...args: unknown[]) => Function }} PrismaRuntime
   */
  const prismaRuntime = /** @type {PrismaRuntime} */ (runtime)
  const originalGetPrismaClient = prismaRuntime.getPrismaClient

  if (!originalGetPrismaClient) {
    return runtime
  }

  /**
   * @param {PrismaRuntimeConfig|undefined} config
   */
  const wrappedGetPrismaClient = function (config) {
    const datasourceName = config?.datasourceNames?.[0] || 'db'
    const runtimeDatasourceUrl = resolveDatasourceUrl(config, datasourceName)
    const runtimeDbConfig = parseDBString(runtimeDatasourceUrl)

    const PrismaClient = originalGetPrismaClient.call(this, config)
    return class WrappedPrismaClientClass extends PrismaClient {
      constructor (clientConfig) {
        super(clientConfig)
        /**
         * @type {PrismaHelperCtx}
         */
        const prismaHelperCtx = {
          dbConfig: resolveClientDbConfig(clientConfig, datasourceName, runtimeDbConfig),
        }
        prismaHelperInit.publish(prismaHelperCtx)

        const helper = prismaHelperCtx.helper
        this._tracingHelper = helper
        this._engine.tracingHelper = helper
      }
    }
  }

  if (isIitm) {
    prismaRuntime.getPrismaClient = wrappedGetPrismaClient
    return runtime
  }

  return new Proxy(prismaRuntime, {
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

/**
 * @param {string|undefined} dbString
 * @returns {DbConfig|undefined}
 */
function parseDBString (dbString) {
  if (!dbString || typeof dbString !== 'string') {
    return
  }

  const sqlServerConfig = parseSqlServerConnectionString(dbString)
  if (sqlServerConfig) {
    return sqlServerConfig
  }

  try {
    const url = new URL(dbString)
    return normalizeDbConfig({
      user: url.username,
      password: url.password,
      host: url.hostname,
      port: url.port,
      database: url.pathname?.slice(1) || undefined,
    })
  } catch {}
}

/**
 * @param {string} dbString
 * @returns {DbConfig|undefined}
 */
function parseSqlServerConnectionString (dbString) {
  if (!dbString.startsWith('sqlserver://')) {
    return
  }
  const segments = dbString.slice(12).split(';').filter(Boolean)
  if (!segments.length) {
    return
  }

  let hostPart = segments.shift()
  let user
  let password
  if (hostPart?.includes('@')) {
    const [userInfo, hostInfo] = hostPart.split('@')
    hostPart = hostInfo
    ;[user, password] = userInfo.split(':')
  }

  let database
  for (const segment of segments) {
    const [rawKey, ...rawValue] = segment.split('=')
    const value = rawValue.join('=').trim()
    const key = rawKey?.trim().toLowerCase()
    if (!key || !value) {
      continue
    }
    if (key === 'database' || key === 'databasename' || key === 'db') database = value
    else if (key === 'user' || key === 'username' || key === 'uid') user = value
    else if (key === 'password' || key === 'pwd') password = value
  }

  const [host, port] = hostPart?.split(':') ?? []

  return normalizeDbConfig({ user, password, host, port, database })
}
