const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

module.exports = resolveNaming({
  send: {
    v0: {
      opName: 'amqp.send',
      serviceName: 'test-amqp-producer'
    },
    v1: {
      opName: 'amqp.send',
      serviceName: 'test'
    }
  },
  receive: {
    v0: {
      opName: 'amqp.receive',
      serviceName: 'test'
    },
    v1: {
      opName: 'amqp.process',
      serviceName: 'test'
    }
  }
})
