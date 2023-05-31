'use strict'

const snapshotKinds = Object.freeze({
  PERIODIC: 'periodic',
  ON_SHUTDOWN: 'on_shutdown',
  ON_OUT_OF_MEMORY: 'on_oom'
})

const oomExportStrategies = Object.freeze({
  PROCESS: 'process',
  ASYNC_CALLBACK: 'async',
  LOGS: 'logs'
})

module.exports = { snapshotKinds, oomExportStrategies }
