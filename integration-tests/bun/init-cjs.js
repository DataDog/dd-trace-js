'use strict'

const tracer = require('dd-trace')

tracer.init({ startupLogs: false })

// eslint-disable-next-line no-console
console.log('ok')
process.exit()
