const { namingResolver } = require('./util')

function identityService (ddService) {
  return ddService
}

const schema = {
  messaging: {
    outbound: {
      rhea: {
        opName: () => 'amqp.send',
        serviceName: identityService
      }
    },
    inbound: {
      rhea: {
        opName: () => 'amqp.process',
        serviceName: identityService
      }
    }
  }
}

module.exports = namingResolver(schema)
