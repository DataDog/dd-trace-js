const SchemaDefinition = require('./definition')

function identityService (service) {
  return service
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

module.exports = new SchemaDefinition(schema)
