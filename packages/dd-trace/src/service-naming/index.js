const { schemaDefinitions } = require('./schemas')

class SchemaManager {
  constructor () {
    this.schemas = schemaDefinitions
    this.config = { spanAttributeSchema: 'v0', traceRemoveIntegrationServiceNamesEnabled: false }
  }

  get schema () {
    return this.schemas[this.version]
  }

  get version () {
    return this.config.spanAttributeSchema
  }

  get shouldUseConsistentServiceNaming () {
    return this.config.traceRemoveIntegrationServiceNamesEnabled && this.version === 'v0'
  }

  opName (type, kind, plugin, ...opNameArgs) {
    return this.schema.getOpName(type, kind, plugin, ...opNameArgs)
  }

  serviceName (type, kind, plugin, ...serviceNameArgs) {
    const schema = this.shouldUseConsistentServiceNaming
      ? this.schemas['v1']
      : this.schema

    return schema.getServiceName(type, kind, plugin, this.config.service, ...serviceNameArgs)
  }

  configure (config = {}) {
    this.config = config
  }
}

module.exports = new SchemaManager()
