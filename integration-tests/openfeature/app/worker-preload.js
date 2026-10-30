'use strict'

const { isMainThread } = require('node:worker_threads')

if (!isMainThread) throw new Error('An application preload ran in the telemetry worker')
