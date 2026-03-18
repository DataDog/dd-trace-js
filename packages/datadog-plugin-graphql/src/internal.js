'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class GraphqlParsePlugin extends TracingPlugin {
  static id = 'graphql'
  static prefix = 'tracing:orchestrion:graphql:graphql_parse'

  bindStart (ctx) {
    const source = ctx.arguments?.[0]

    this.startSpan('graphql.parse', {
      service: this.config.service,
      type: 'graphql',
      meta: {
        component: 'graphql',
        'graphql.source': typeof source === 'string' ? source : undefined,
      },
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    if (ctx.error) {
      const span = ctx.currentStore?.span
      if (span) {
        span.setTag('error', ctx.error)
      }
    }

    super.finish(ctx)
  }
}

class GraphqlValidatePlugin extends TracingPlugin {
  static id = 'graphql'
  static prefix = 'tracing:orchestrion:graphql:graphql_validate'

  bindStart (ctx) {
    this.startSpan('graphql.validate', {
      service: this.config.service,
      type: 'graphql',
      meta: {
        component: 'graphql',
      },
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    const span = ctx.currentStore?.span
    if (span) {
      if (ctx.error) {
        span.setTag('error', ctx.error)
      } else if (Array.isArray(ctx.result) && ctx.result.length > 0) {
        // validate() returns an array of GraphQLError objects on failure
        span.setTag('error', ctx.result[0])
      }
    }

    super.finish(ctx)
  }
}

module.exports = {
  parse: GraphqlParsePlugin,
  validate: GraphqlValidatePlugin,
}
