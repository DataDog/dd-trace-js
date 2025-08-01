'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')
const { storage } = require('../../datadog-core')

class FastifyTracingPlugin extends RouterPlugin {
  static get id () {
    return 'fastify'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:fastify:request:handle', ({ req }) => {
      this.setFramework(req, 'fastify', this.config)
    })

    this.addBind('datadog:fastify:pre-parsing:start', getParentStore)
    this.addBind('datadog:fastify:pre-validation:start', getParentStore)
    this.addBind('datadog:fastify:add-hook:start', getParentStore)

    this.addSub('datadog:fastify:pre-parsing:finish', (ctx) => {
      return ctx.parentStore
    })
    this.addSub('datadog:fastify:pre-validation:finish', (ctx) => {
      return ctx.parentStore
    })
    this.addSub('datadog:fastify:add-hook:finish', (ctx) => {
      return ctx.parentStore
    })
  }
}

function getParentStore (ctx) {
  ctx.parentStore = ctx.parentStore ?? storage('legacy').getStore()
  return ctx.parentStore
}

module.exports = FastifyTracingPlugin
