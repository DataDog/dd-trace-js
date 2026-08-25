'use strict'

const dc = require('dc-polyfill')

const iastQueryStartChannel = dc.channel('datadog:iast:mariadb:query:start')
const iastQueryFinishChannel = dc.channel('datadog:iast:mariadb:query:finish')

const iastStage = {
  name: 'iast.sql-injection',
  requires: ['tracing'],

  /**
   * Analyze the original statement inside the traced query scope when IAST is active.
   *
   * @param {import('../../dd-trace/src/plugins/integration-pipeline').PipelineFrame} frame Pipeline frame.
   * @returns {void}
   */
  start (frame) {
    if (!iastQueryStartChannel.hasSubscribers) return

    frame.data.iastStarted = true
    iastQueryStartChannel.publish({ sql: frame.data.statement })
  },

  /**
   * Restore the IAST parent store after a query that entered an analyzed store.
   *
   * @param {import('../../dd-trace/src/plugins/integration-pipeline').PipelineFrame} frame Pipeline frame.
   * @returns {void}
   */
  complete (frame) {
    if (frame.data.iastStarted) iastQueryFinishChannel.publish()
  },
}

const dbmStage = {
  name: 'dbm.propagation',
  requires: ['tracing', 'dbm'],

  /**
   * Inject DBM propagation into the driver-owned query while retaining the original span resource.
   *
   * @param {import('../../dd-trace/src/plugins/integration-pipeline').PipelineFrame} frame Pipeline frame.
   * @returns {void}
   */
  start (frame) {
    const statement = frame.data.statement
    if (typeof statement !== 'string') return

    const injectedStatement = frame.dbm.injectQuery(statement)
    const context = frame.invocation
    if (context.sql !== null && typeof context.sql === 'object') {
      context.sql.sql = injectedStatement
    } else {
      context.sql = injectedStatement
    }
  },
}

module.exports = { dbmStage, iastStage }
