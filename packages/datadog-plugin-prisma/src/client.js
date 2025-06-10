'use strict'
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
class PrismaClientPlugin extends DatabasePlugin {
  static get id () { return 'prisma' }
  static get operation () { return 'client' }
  static get system () { return 'prisma' }
  static get prefix () {
    return 'tracing:apm:prisma:client'
  }

  bindStart (ctx) {
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
    const operationName = this.operationName({ operation: this.operation })
    this.startSpan(operationName, options, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    // Only synchronous operations would have `result` on `end`.
    if (Object.hasOwn(ctx, 'result')) {
      this.finish(ctx)
    }
  }

  bindAsyncStart (ctx) {
    return this.bindFinish(ctx)
  }

  asyncStart (ctx) {
    this.finish(ctx)
  }

  error (error) {
    this.addError(error)
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

module.exports = PrismaClientPlugin
