const v0 = require('./schemas/v0')
const v1 = require('./schemas/v1')

const schemas = { v0, v1 }

class Schema {
  constructor () {
    this.schemas = schemas
    this.config = { spanAttributeSchema: 'v0' }
  }

  get schema () {
    return this.schemas[this.version]
  }

  get version () {
    return this.config.spanAttributeSchema
  }

  configure (config = {}) {
    this.config = config
  }
}

module.exports = new Schema()
