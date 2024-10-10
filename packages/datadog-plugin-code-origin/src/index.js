'use strict'

const fastify = require('./fastify')
const RouterPlugin = require('../../datadog-plugin-router/src')

class CodeOriginForSpansPlugin extends RouterPlugin {
  static get id () {
    return 'code-origin-for-spans'
  }

  constructor (...args) {
    super(...args)
    fastify(this)
  }
}

module.exports = CodeOriginForSpansPlugin
