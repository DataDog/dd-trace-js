'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class GoogleCloudPubsubClientPlugin extends ClientPlugin {
  static id = 'google-cloud-pubsub'
  static type = 'messaging'
  static operation = 'request'

  start (ctx) {
    const { request, api, projectId, storedContext } = ctx

    if (api === 'publish') return

    const snOpts = {}
    const service = this.config.service || this.serviceName(snOpts)
    const srvSrc = this.config.service
      ? (this.config.serviceFromMapping ? 'opt.mapping' : 'm')
      : snOpts.srvSrc

    const spanOptions = {
      service,
      srvSrc,
      resource: [api, request.name].filter(Boolean).join(' '),
      kind: this.constructor.kind,
      meta: {
        'pubsub.method': api,
        'gcloud.project_id': projectId,
      },
    }

    /**
     * Use stored context from consumer plugin to link acknowledge span to message processing span.
     * Without this, the acknowledge span would be orphaned (no async context available).
     */
    if (storedContext?.span) {
      spanOptions.childOf = storedContext.span.context()
    }

    this.startSpan(this.operationName(), spanOptions, ctx)

    return ctx.currentStore
  }
}

module.exports = GoogleCloudPubsubClientPlugin
