'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class GoogleCloudPubsubClientPlugin extends ClientPlugin {
  static id = 'google-cloud-pubsub'
  static type = 'messaging'
  static operation = 'request'

  start (ctx) {
    const { request, api, projectId } = ctx

    if (api === 'publish') return

    const explicitParent = ctx.parentSpan // From restored context in wrapMethod
    const spanOptions = {
      service: this.config.service || this.serviceName(),
      resource: [api, request.name].filter(Boolean).join(' '),
      kind: this.constructor.kind,
      meta: {
        'pubsub.method': api,
        'gcloud.project_id': projectId
      }
    }

    // If we have an explicit parent span (from restored context), use it
    if (explicitParent) {
      spanOptions.childOf = explicitParent.context()
    }

    this.startSpan(this.operationName(), spanOptions, ctx)

    return ctx.currentStore
  }
}

module.exports = GoogleCloudPubsubClientPlugin
