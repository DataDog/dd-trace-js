'use strict'

// package.json must be loaded before dd-trace to verify this order works.
/* eslint-disable import/order */
const pkg = require('../package.json')
const tracer = require('dd-trace')
/* eslint-enable import/order */

tracer.init({ startupLogs: false })

// eslint-disable-next-line no-console
console.log(pkg.name || 'unnamed')
// eslint-disable-next-line no-console
console.log('ok')
process.exit()
