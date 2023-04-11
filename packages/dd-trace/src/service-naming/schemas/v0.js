const SchemaDefinition = require('./definition')

const schema = {
  messaging: {
    outbound: {
      rhea: {
        opName: () => 'amqp.send',
        serviceName: (service) => `${service}-amqp-producer`
      }
    },
    inbound: {
      rhea: {
        opName: () => 'amqp.receive',
        serviceName: (service) => service
      }
    }
  }
}

module.exports = new SchemaDefinition(schema)
