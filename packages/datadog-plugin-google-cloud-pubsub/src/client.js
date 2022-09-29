'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class GoogleCloudPubsubClientPlugin extends ClientPlugin {
  static get name () { return 'google-cloud-pubsub' }
  static get operation () { return 'request' }

  start ({ cfg, projectId }) {
    if (cfg.method === 'publish') return

    this.startSpan('pubsub.request', {
      service: this.config.service || `${this.tracer._service}-pubsub`,
      resource: [cfg.method, cfg.reqOpts.name].filter(x => x).join(' '),
      kind: 'client',
      meta: {
        'component': '@google-cloud/pubsub',
        'pubsub.method': cfg.method,
        'gcloud.project_id': projectId
      }
    })
  }
}

module.exports = GoogleCloudPubsubClientPlugin
