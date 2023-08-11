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

  opName (type, kind, plugin, opts) {
    return this.schema.getOpName(type, kind, plugin, opts)
  }

  serviceName (type, kind, plugin, opts) {
    const schema = this.shouldUseConsistentServiceNaming
      ? this.schemas.v1
      : this.schema

    return schema.getServiceName(type, kind, plugin, { ...opts, tracerService: this.config.service })
  }

  configure (config = {}) {
    this.config = config
  }
}

module.exports = new SchemaManager()
