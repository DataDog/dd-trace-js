'use strict'
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class PrismaCLientPlugin extends DatabasePlugin {
  static get id () { return 'prisma' }
  static get operation () { return 'client' }
  static get system () { return 'prisma' }

  start (ctx) {
    const service = this.serviceName({ pluginConfig: this.config })
    const resource = formatResourceName(ctx.resourceName, ctx.attributes)
    const options = { service, resource }

    if (ctx.resourceName === 'operation') {
      options.meta = {
        prisma: {
          method: ctx.attributes.method,
          model: ctx.attributes.model,
          type: 'client'
        }
      }
    }
    this.startSpan(this.operationName({ operation: this.operation }), options)
  }
}

function formatResourceName (resource, attributes) {
  if (attributes?.name) {
    return `${attributes.name}`.trim()
  }
  if (attributes?.model && attributes.method) {
    return `${attributes.model}.${attributes.method}`.trim()
  }
  return resource
}

module.exports = PrismaCLientPlugin
