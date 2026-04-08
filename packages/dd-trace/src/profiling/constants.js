'use strict'

const snapshotKinds = Object.freeze({
  PERIODIC: 'periodic',
  ON_SHUTDOWN: 'on_shutdown',
  ON_OUT_OF_MEMORY: 'on_oom',
})

const oomExportStrategies = Object.freeze({
  PROCESS: 'process',
  ASYNC_CALLBACK: 'async',
  LOGS: 'logs',
})

const allocationDefaults = Object.freeze({
  MAX_HEAP_BYTES: 536_870_912, // 512 Mb
  MAX_WINDOW_DURATION_MS: 60_000, // 60s
  HEAP_MONITOR_INTERVAL_MS: 5000, // 5s
})

module.exports = { snapshotKinds, oomExportStrategies, allocationDefaults }
