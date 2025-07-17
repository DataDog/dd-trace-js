'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class GoogleCloudPubsubClientPlugin extends ClientPlugin {
  static get id () { return 'google-cloud-pubsub' }
  static get type () { return 'messaging' }
  static get operation () { return 'request' }

  start (ctx) {
    const { request, api, projectId } = ctx

    if (api === 'publish') return

    this.startSpan(this.operationName(), {
      service: this.config.service || this.serviceName(),
      resource: [api, request.name].filter(Boolean).join(' '),
      kind: this.constructor.kind,
      meta: {
        'pubsub.method': api,
        'gcloud.project_id': projectId
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = GoogleCloudPubsubClientPlugin
