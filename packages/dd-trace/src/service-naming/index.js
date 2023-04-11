const { schemaDefinitions } = require('./schemas')

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

  opName (type, ioDirection, plugin, opNameArgs) {
    return this.schema.getOpName(type, ioDirection, plugin, opNameArgs)
  }

  serviceName (type, ioDirection, plugin, serviceNameArgs) {
    return this.schema.getServiceName(type, ioDirection, plugin, serviceNameArgs)
  }

  configure (config = {}) {
    this.config = config
    Object.values(this.schemas).forEach(schemaDef => {
      schemaDef.configure(config)
    })
  }
}

module.exports = new SchemaManager()
