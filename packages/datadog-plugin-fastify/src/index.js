'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')

class FastifyPlugin extends RouterPlugin {
  static get id () {
    return 'fastify'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:fastify:request:handle', ({ req, tags }) => {
      this.setFramework(req, 'fastify', this.config)
      this.setSpanTags(req, tags)
    })
  }
}

module.exports = FastifyPlugin
