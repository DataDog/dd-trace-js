'use strict'

class SchemaManager {
  /**
   * @type {object}
   */
  config = {
    spanAttributeSchema: 'v0',
    spanRemoveIntegrationFromService: false
  }

  schemas = {
    v0: require('./schemas/v0'),
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

  /**
   * @param {string} type
   * @param {string} kind
   * @param {string} plugin
   * @param {object} opts
   * @returns {string}
   */
  opName (type, kind, plugin, opts) {
    return this.schema.getOpName(type, kind, plugin, opts)
  }

  /**
   * @param {string} type
   * @param {string} kind
   * @param {string} plugin
   * @param {object} opts
   * @returns {string}
   */
  serviceName (type, kind, plugin, opts) {
    const schema = this.shouldUseConsistentServiceNaming
      ? this.schemas.v1
      : this.schema

    return schema.getServiceName(type, kind, plugin, { ...opts, tracerService: this.config.service })
  }

  /**
   * @param {object} config
   * @param {string} config.spanAttributeSchema
   * @param {boolean} config.spanRemoveIntegrationFromService
   * @param {string} [config.service]
   */
  configure (config) {
    const { spanAttributeSchema, spanRemoveIntegrationFromService } = config

    if (!this.schemas.v0 && spanAttributeSchema === 'v0') {
      this.schemas.v0 = require('./schemas/v0')
    }

    if (!this.schemas.v1 && (spanAttributeSchema === 'v1' || spanRemoveIntegrationFromService)) {
      this.schemas.v1 = require('./schemas/v1')
    }

    this.config = config
  }
}

module.exports = new SchemaManager()
