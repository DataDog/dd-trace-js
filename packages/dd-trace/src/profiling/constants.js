'use strict'

const SnapshotKinds = Object.freeze({ Periodic: 'periodic', OnShutdown: 'on_shutdown', OnOutOfMemory: 'on_oom' })
const OOMExportStrategies = Object.freeze({ Process: 'process',
  AsyncCallback: 'async',
  InteruptCallback: 'interrupt',
  Logs: 'logs' })

module.exports = { SnapshotKinds, OOMExportStrategies }
