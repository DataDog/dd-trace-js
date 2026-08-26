'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const { createIntegrationPlugin } = require('../../dd-trace/src/plugins/integration-pipeline')
const MariaDBPipelineBase = require('./base')
const source = require('./source')
const { dbmStage, iastStage } = require('./stages')

const system = 'mariadb'

/**
 * Extract MariaDB connection fields without retaining the driver configuration object.
 *
 * @param {Record<string, unknown>} invocation MariaDB instrumentation context.
 * @returns {Record<string, unknown>} Query operation facts.
 */
function extractQuery (invocation) {
  const conf = invocation.conf || {}
  const sql = invocation.sql

  return {
    database: conf.database,
    host: conf.host,
    poolWaitTime: invocation.poolWaitTime,
    port: conf.port,
    statement: typeof sql === 'string' ? sql : sql?.sql,
    user: conf.user,
  }
}

/**
 * Extract MariaDB pool acquisition fields without retaining the driver configuration object.
 *
 * @param {Record<string, unknown>} invocation MariaDB instrumentation context.
 * @returns {Record<string, unknown>} Pool operation facts.
 */
function extractPoolAcquire (invocation) {
  const conf = invocation.conf || {}

  return {
    database: conf.database,
    host: conf.host,
    port: conf.port,
    startTime: invocation.startTime,
    user: conf.user,
  }
}

module.exports = createIntegrationPlugin({
  id: system,
  base: MariaDBPipelineBase,
  source,
  operations: [{
    target: { module: system, name: 'query' },
    lifecycle: 'async',
    context: {
      parent: frame => frame.invocation.sourceParentStore?.span || null,
    },
    extract: {
      start: extractQuery,
    },
    span: {
      name: 'mariadb.query',
      service: frame => frame.serviceName({
        dbConfig: {
          database: frame.data.database,
          host: frame.data.host,
          port: frame.data.port,
          user: frame.data.user,
        },
        pluginConfig: frame.config,
        system,
      }),
      resource: frame => frame.data.statement,
      type: 'sql',
      kind: 'client',
      tags: {
        'db.type': system,
        'db.user': frame => frame.data.user,
        'db.name': frame => frame.data.database,
        'out.host': frame => frame.data.host,
        [CLIENT_PORT_KEY]: frame => frame.data.port,
      },
      metrics: {
        'mariadb.pool.wait_time': frame => frame.data.poolWaitTime,
      },
    },
    stages: [iastStage, dbmStage],
  }, {
    target: { module: system, name: 'pool.acquire' },
    lifecycle: 'async',
    context: {
      parent: frame => frame.invocation.sourceParentStore?.span || null,
    },
    extract: {
      start: extractPoolAcquire,
      complete: { poolWaitTime: invocation => invocation.poolWaitTime },
    },
    span: {
      name: 'mariadb.pool.acquire',
      service: frame => frame.serviceName({
        dbConfig: {
          database: frame.data.database,
          host: frame.data.host,
          port: frame.data.port,
          user: frame.data.user,
        },
        pluginConfig: frame.config,
        system,
      }),
      resource: 'mariadb.pool.acquire',
      type: 'sql',
      kind: 'client',
      startTime: frame => frame.data.startTime,
      tags: {
        'db.type': system,
        'db.user': frame => frame.data.user,
        'db.name': frame => frame.data.database,
        'out.host': frame => frame.data.host,
        [CLIENT_PORT_KEY]: frame => frame.data.port,
      },
      resultTags: {
        'mariadb.pool.wait_time': frame => frame.data.poolWaitTime,
      },
    },
  }],
})
