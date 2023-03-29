'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class GoogleCloudPubsubClientPlugin extends ClientPlugin {
  static get id () { return 'google-cloud-pubsub' }
  static get operation () { return 'request' }

  start ({ request, api, projectId }) {
    if (api === 'publish') return

    this.startSpan('pubsub.request', {
      service: this.config.service || `${this.tracer._service}-pubsub`,
      resource: [api, request.name].filter(x => x).join(' '),
      kind: 'client',
      meta: {
        'pubsub.method': api,
        'gcloud.project_id': projectId
      }
    })
  }
}

module.exports = GoogleCloudPubsubClientPlugin
