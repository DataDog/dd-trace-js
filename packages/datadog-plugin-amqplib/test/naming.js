const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  send: {
    v0: {
      opName: 'amqp.command',
      serviceName: 'test-amqp'
    },
    v1: {
      opName: 'amqp.send',
      serviceName: 'test'
    }
  },
  receive: {
    v0: {
      opName: 'amqp.command',
      serviceName: 'test-amqp'
    },
    v1: {
      opName: 'amqp.process',
      serviceName: 'test'
    }
  },
  controlPlane: {
    v0: {
      opName: 'amqp.command',
      serviceName: 'test-amqp'
    },
    v1: {
      opName: 'amqp.command',
      serviceName: 'test'
    }
  }
})
