'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['inspector/promises'] }] */

const { builtinModules } = require('node:module')

if (builtinModules.includes('inspector/promises')) {
  // @ts-ignore - inspector/promises is available in Node.js 20+ but not in @types/node@18
  module.exports = require('node:inspector/promises')
} else {
  const inspector = require('node:inspector')
  const { promisify } = require('node:util')

  // The rest of the code in this file is lifted from:
  // https://github.com/nodejs/node/blob/1d4d76ff3fb08f9a0c55a1d5530b46c4d5d550c7/lib/inspector/promises.js
  // @ts-expect-error - We intentionally override 'post' with a promisified version, changing its signature
  class Session extends inspector.Session {
    constructor () { super() } // eslint-disable-line no-useless-constructor
  }

  Session.prototype.post = promisify(inspector.Session.prototype.post)

  module.exports = {
    ...inspector,
    Session
  }
}
