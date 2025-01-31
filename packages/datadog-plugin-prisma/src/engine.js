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
    // console.log('PrismaEngine start called', ctx.engineSpan)
    const { engineSpan, allEngineSpans, childOf, dbConfig } = ctx

    const service = this.serviceName({ pluginConfig: this.config, system: this.system })

    const unixStartTime = hrTimeToUnixTimeMs(engineSpan.startTime)

    const spanName = engineSpan.name.substring(14) // remove 'prisma:engine:' prefix
    let options = {
      childOf,
      service,
      kind: engineSpan.kind,
      meta: {
        prisma: {
          name: spanName,
          type: 'engine'
        }
      }
    }

    switch (spanName) {
      case 'db_query':{
        const query = engineSpan.attributes['db.query.text']
        const originalStatement = this.maybeTruncate(query)
        let type
        let dbType
        if (databaseDriverMapper[engineSpan.attributes['db.system']]) {
          type = databaseDriverMapper[engineSpan.attributes['db.system']].type
          dbType = databaseDriverMapper[engineSpan.attributes['db.system']]['db.type']
        }

        // Start time format is defined here
        //  https://github.com/open-telemetry/opentelemetry-js/blob/cbc912d/api/src/common/Time.ts#L19-L30.
        options = {
          ...options,
          resource: originalStatement,
          startTime: unixStartTime,
          type: type || engineSpan.attributes['db.system'],
          meta: {
            ...options.meta,
            'db.type': dbType || engineSpan.attributes['db.system'],
            'db.instance': dbConfig?.database,
            'db.name': dbConfig?.user,
            'out.host': dbConfig?.host,
            [CLIENT_PORT_KEY]: dbConfig?.port
          },
          childOf
        }
      }
        break

      default:{
        options = { ...options, resource: spanName, startTime: unixStartTime, childOf }
        break
      }
    }

    const activeSpan = this.startSpan(this.operationName({ operation: this.operation }), options)
    const children = allEngineSpans.filter((span) => span.parentId === engineSpan.id)
    for (const child of children) {
      const startCtx = { engineSpan: child, allEngineSpans, childOf: activeSpan, dbConfig }
      this.start(startCtx)
    }
    const unixEndTime = hrTimeToUnixTimeMs(engineSpan.endTime)
    activeSpan.finish(unixEndTime)
  }
}

function hrTimeToUnixTimeMs ([seconds, nanoseconds]) {
  return seconds * 1000 + nanoseconds / 1e6
}

module.exports = PrismaEngine
