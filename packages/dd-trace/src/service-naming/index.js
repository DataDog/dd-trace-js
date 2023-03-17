const Config = require('../config')
const v0 = require('./schemas/v0')
const v1 = require('./schemas/v1')

const schemas = { v0, v1 }

class Schema {
  constructor () {
    this.schemas = schemas
    this.versionName = this.loadVersionConfig()
  }

  get schema () {
    return this.schemas[this.versionName]
  }

  loadVersionConfig () {
    return new Config().spanAttributeSchema
  }

  reload () {
    /**
     * This function is only provided for testing purposes.
     * The value of the version name should only ever be modified when launching the process.
     */
    this.versionName = this.loadVersionConfig()
  }
}

module.exports = new Schema()
