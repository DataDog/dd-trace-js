const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  send: {
    v0: {
      opName: 'pubsub.request',
      serviceName: 'test-pubsub'
    },
    v1: {
      opName: 'gcp.pubsub.send',
      serviceName: 'test'
    }
  },
  receive: {
    v0: {
      opName: 'pubsub.receive',
      serviceName: 'test'
    },
    v1: {
      opName: 'gcp.pubsub.process',
      serviceName: 'test'
    }
  },
  controlPlane: {
    v0: {
      opName: 'pubsub.request',
      serviceName: 'test-pubsub'
    },
    v1: {
      opName: 'gcp.pubsub.request',
      serviceName: 'test'
    }
  }
})
