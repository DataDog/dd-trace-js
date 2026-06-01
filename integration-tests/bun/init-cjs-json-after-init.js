'use strict'

const tracer = require('dd-trace')

tracer.init({ startupLogs: false })

const pkg = require('../package.json')

// eslint-disable-next-line no-console
console.log(pkg.name || 'unnamed')
// eslint-disable-next-line no-console
console.log('ok')
process.exit()
