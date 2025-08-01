'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class FastifyTracingPlugin extends RouterPlugin {
  static id = 'fastify'

  constructor (...args) {
    super(...args)

    this.addSub('apm:fastify:request:handle', ({ req }) => {
      this.setFramework(req, 'fastify', this.config)
    })
  }
}

module.exports = FastifyTracingPlugin
