'use strict'

const MongodbCoreQueryPlugin = require('./query')

const MAX_RESOURCE_LENGTH = 10_000

class MongodbCoreBulkWritePlugin extends MongodbCoreQueryPlugin {
  // bulkWrite is higher-level than the wire commands `query` traces, so it has its own operation
  // and thus its own `apm:mongodb:bulkwrite:*` channels. It reuses the query plugin's `id`,
  // `component`, and collection-stripping `getPeerService`, and inherits `finish`, `error`, and the
  // finish-time parent-store restore from the tracing/outbound base classes.
  static operation = 'bulkwrite'

  /**
   * Open the parent span for a `Collection#bulkWrite`. The per-type wire commands nest as
   * children and carry the statements, host, and DBM comment, so this span only records
   * the namespace and resource.
   *
   * @param {{ ns: string }} ctx
   */
  bindStart (ctx) {
    const { ns } = ctx
    const serviceResult = this.serviceName({ pluginConfig: this.config })

    this.startSpan(this.operationName(), {
      service: serviceResult,
      resource: truncate(`bulkWrite ${ns}`),
      type: 'mongodb',
      kind: 'client',
      meta: {
        'db.name': ns,
      },
    }, ctx)

    return ctx.currentStore
  }
}

function truncate (input) {
  return input.length > MAX_RESOURCE_LENGTH ? input.slice(0, MAX_RESOURCE_LENGTH) : input
}

module.exports = MongodbCoreBulkWritePlugin
