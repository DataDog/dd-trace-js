'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class FastifyPlugin extends RouterPlugin {
  static get name () {
    return 'fastify'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:fastify:request:handle', ({ req }) => {
      this.setFramework(req, 'fastify', this.config)
    })
  }
}

module.exports = FastifyPlugin
