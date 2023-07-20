const { schemaDefinitions } = require('./schemas')

class SchemaManager {
  constructor () {
    this.schemas = schemaDefinitions
    this.config = { spanAttributeSchema: 'v0', spanRemoveIntegrationFromService: false }
  }

  get schema () {
    return this.schemas[this.version]
  }

  get version () {
    return this.config.spanAttributeSchema
  }

  get shouldUseConsistentServiceNaming () {
    return this.config.spanRemoveIntegrationFromService && this.version === 'v0'
  }

  opName (type, kind, plugin, ...opNameArgs) {
    return this.schema.getOpName(type, kind, plugin, ...opNameArgs)
  }

  serviceName (type, kind, plugin, ...serviceNameArgs) {
    return this.schema.getServiceName(type, kind, plugin, this.config.service, ...serviceNameArgs)
  }

  shortCircuitServiceName (pluginConfig, ...args) {
    // We're short-circuiting, so we do not obey custom service functions
    if (typeof pluginConfig.service === 'function') {
      return this.config.service
    }
    return pluginConfig.service || this.config.service
  }

  configure (config = {}) {
    this.config = config
  }
}

module.exports = new SchemaManager()
