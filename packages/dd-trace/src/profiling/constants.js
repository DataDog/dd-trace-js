'use strict'

// 99hz in milliseconds.
const SAMPLING_INTERVAL = 1e3 / 99

const snapshotKinds = Object.freeze({
  PERIODIC: 'periodic',
  ON_SHUTDOWN: 'on_shutdown',
  ON_OUT_OF_MEMORY: 'on_oom',
})

module.exports = { SAMPLING_INTERVAL, snapshotKinds }
