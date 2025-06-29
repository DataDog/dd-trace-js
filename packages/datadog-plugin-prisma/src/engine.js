'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')

const databaseDriverMapper = {
  postgresql: {
    type: 'sql',
    'db.type': 'postgres'
  },
  mysql: {
    type: 'sql',
    'db.type': 'mysql'
  },
  mongodb: {
    type: 'mongodb',
    'db.type': 'mongodb'
  },
  sqlite: {
    type: 'sql',
    'db.type': 'sqlite'
  }
}

class PrismaEngine extends DatabasePlugin {
  static get id () { return 'prisma' }
  static get operation () { return 'engine' }
  static get system () { return 'prisma' }

  start (ctx) {
    const { engineSpan, allEngineSpans, childOf, dbConfig } = ctx
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
          type: 'engine'
        }
      }
    }

    if (spanName === 'db_query') {
      const query = engineSpan.attributes['db.query.text']
      const originalStatement = this.maybeTruncate(query)
      const type = databaseDriverMapper[engineSpan.attributes['db.system']]?.type
      const dbType = databaseDriverMapper[engineSpan.attributes['db.system']]?.['db.type']

      options.resource = originalStatement
      options.type = type || engineSpan.attributes['db.system']
      options.meta['db.type'] = dbType || engineSpan.attributes['db.system']
      options.meta['db.instance'] = dbConfig?.database
      options.meta['db.name'] = dbConfig?.user
      options.meta['out.host'] = dbConfig?.host
      options.meta[CLIENT_PORT_KEY] = dbConfig?.port
    }

    const activeSpan = this.startSpan(this.operationName({ operation: this.operation }), options)
    activeSpan._startTime = hrTimeToUnixTimeMs(engineSpan.startTime)
    for (const span of allEngineSpans) {
      if (span.parentId === engineSpan.id) {
        const startCtx = { engineSpan: span, allEngineSpans, childOf: activeSpan, dbConfig }
        this.start(startCtx)
      }
    }
    const unixEndTime = hrTimeToUnixTimeMs(engineSpan.endTime)
    activeSpan.finish(unixEndTime)
  }
}

// Opentelemetry time format is defined here
// https://github.com/open-telemetry/opentelemetry-js/blob/cbc912d/api/src/common/Time.ts#L19-L30.
function hrTimeToUnixTimeMs ([seconds, nanoseconds]) {
  return seconds * 1000 + nanoseconds / 1e6
}

module.exports = PrismaEngine
