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

  opName (type, kind, plugin, ...opNameArgs) {
    return this.schema.getOpName(type, kind, plugin, ...opNameArgs)
  }

  serviceName (type, kind, plugin, ...serviceNameArgs) {
    if (this.config.traceRemoveIntegrationServiceNamesEnabled && this.version === "v0") {
      return this.config.service
    }
    return this.schema.getServiceName(type, kind, plugin, this.config.service, ...serviceNameArgs)
  }

  configure (config = {}) {
    this.config = config
  }
}

module.exports = new SchemaManager()
