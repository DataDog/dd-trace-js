const { schemaDefinitions } = require('./schemas')

const kindMap = {
  messaging: {
    client: 'controlPlane',
    consumer: 'inbound',
    producer: 'outbound'
  }
}

class SchemaManager {
  constructor () {
    this.schemas = schemaDefinitions
    this.config = { spanAttributeSchema: 'v0' }
  }

  get schema () {
    return this.schemas[this.version]
  }

  get version () {
    return this.config.spanAttributeSchema
  }

  opName (type, kind, plugin, opNameArgs) {
    return this.schema.getOpName(type, kindMap[type][kind], plugin, opNameArgs)
  }

  serviceName (type, kind, plugin, serviceNameArgs) {
    return this.schema.getServiceName(type, kindMap[type][kind], plugin, this.config.service, serviceNameArgs)
  }

  configure (config = {}) {
    this.config = config
  }
}

module.exports = new SchemaManager()
