'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatadogTracingHelper = require('./datadog-tracing-helper')

const databaseDriverMapper = {
  postgresql: {
    type: 'sql',
    'db.type': 'postgres',
  },
  mysql: {
    type: 'sql',
    'db.type': 'mysql',
  },
  mongodb: {
    type: 'mongodb',
    'db.type': 'mongodb',
  },
  sqlite: {
    type: 'sql',
    'db.type': 'sqlite',
  },
}

class PrismaPlugin extends DatabasePlugin {
  static id = 'prisma'
  static system = 'prisma'
  static prefix = 'tracing:apm:prisma'

  constructor (...args) {
    super(...args)

    // Subscribe to helper initialization to inject callbacks
    this.addSub('apm:prisma:helper:init', (prismaHelperCtx) => {
      prismaHelperCtx.helper = new DatadogTracingHelper(prismaHelperCtx.dbConfig, this)
    })
  }

  startEngineSpan (ctx) {
    const { engineSpan, childrenByParent, childOf, dbConfig } = ctx
    const service = this.serviceName({ pluginConfig: this.config, system: this.system })
    const spanName = engineSpan.name.slice(14) // remove 'prisma:engine:' prefix
    const options = {
      childOf,
      resource: spanName,
      service,
      kind: engineSpan.kind,
      meta: {
        prisma: {
          name: spanName,
          type: 'engine',
        },
      },
    }

    if (spanName === 'db_query') {
      const query = engineSpan.attributes['db.query.text']
      const originalStatement = this.maybeTruncate(query)
      const type = databaseDriverMapper[engineSpan.attributes['db.system']]?.type
      const dbType = databaseDriverMapper[engineSpan.attributes['db.system']]?.['db.type']

      options.resource = originalStatement
      options.type = type || engineSpan.attributes['db.system']
      options.meta['db.type'] = dbType || engineSpan.attributes['db.system']
      options.meta['db.name'] = dbConfig?.database
      options.meta['db.user'] = dbConfig?.user
      options.meta['out.host'] = dbConfig?.host
      options.meta[CLIENT_PORT_KEY] = dbConfig?.port
    }

    const activeSpan = this.startSpan(this.operationName({ operation: 'engine' }), options)
    activeSpan._startTime = hrTimeToUnixTimeMs(engineSpan.startTime)
    const children = childrenByParent?.get(engineSpan.id)
    if (children) {
      for (const span of children) {
        const startCtx = { engineSpan: span, childrenByParent, childOf: activeSpan, dbConfig }
        this.startEngineSpan(startCtx)
      }
    }
    const unixEndTime = hrTimeToUnixTimeMs(engineSpan.endTime)
    activeSpan.finish(unixEndTime)
  }

  bindStart (ctx) {
    const service = this.serviceName({ pluginConfig: this.config })
    const resource = formatResourceName(ctx.resourceName, ctx.attributes)

    const options = { service, resource }

    if (ctx.resourceName === 'operation') {
      options.meta = {
        prisma: {
          method: ctx.attributes.method,
          model: ctx.attributes.model,
          type: 'client',
        },
      }
    }
    const operationName = this.operationName({ operation: 'client' })
    this.startSpan(operationName, options, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    // Only synchronous operations would have `result` on `end`.
    if (Object.hasOwn(ctx, 'result')) {
      this.finish(ctx)
    }
  }

  bindAsyncStart (ctx) {
    return this.bindFinish(ctx)
  }

  asyncStart (ctx) {
    this.finish(ctx)
  }

  error (error) {
    this.addError(error)
  }
}

function formatResourceName (resource, attributes) {
  if (attributes?.name) {
    return `${attributes.name}`.trim()
  }
  if (attributes?.model && attributes.method) {
    return `${attributes.model}.${attributes.method}`.trim()
  }
  return resource
}

// Opentelemetry time format is defined here
// https://github.com/open-telemetry/opentelemetry-js/blob/cbc912d/api/src/common/Time.ts#L19-L30.
function hrTimeToUnixTimeMs ([seconds, nanoseconds]) {
  return seconds * 1000 + nanoseconds / 1e6
}

module.exports = PrismaPlugin
