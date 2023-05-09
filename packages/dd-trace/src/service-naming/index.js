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

  configure ({ spanAttributeSchema }) {
    this.config = { spanAttributeSchema }
  }
}

module.exports = new SchemaManager()
