const { namingResolver } = require('./util')

const schema = {
  messaging: {
    outbound: {
      rhea: {
        opName: () => 'amqp.send',
        serviceName: (ddService) => `${ddService}-amqp-producer`
      }
    },
    inbound: {
      rhea: {
        opName: () => 'amqp.receive',
        serviceName: (ddService) => ddService
      }
    }
  }
}

module.exports = namingResolver(schema)
