'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class GoogleCloudPubsubClientPlugin extends ClientPlugin {
  static get id () { return 'google-cloud-pubsub' }
  static get type () { return 'messaging' }
  static get operation () { return 'request' }

  start ({ request, api, projectId }) {
    if (api === 'publish') return

    this.startSpan(this.operationName(), {
      service: this.config.service || this.serviceName(),
      resource: [api, request.name].filter(x => x).join(' '),
      kind: this.constructor.kind,
      meta: {
        'pubsub.method': api,
        'gcloud.project_id': projectId
      }
    })
  }
}

module.exports = GoogleCloudPubsubClientPlugin
