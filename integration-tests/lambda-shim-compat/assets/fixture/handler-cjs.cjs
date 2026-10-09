'use strict'
const handler = require('./handlers.cjs').createHandler()
exports.handler = process.env.COMPAT_CASE.includes('frozen') ? Object.freeze(handler) : handler
