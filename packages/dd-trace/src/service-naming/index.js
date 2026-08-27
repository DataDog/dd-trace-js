'use strict'

/** @typedef {import('./schemas/definition')} SchemaDefinition */

/**
 * @param {Record<string, SchemaDefinition | undefined>} schemas
 * @param {string} version
 * @returns {SchemaDefinition | undefined}
 */
function getSchema (schemas, version) {
  const schema = schemas[version]
  if (schema !== undefined) return schema

  if (version === 'v0') {
    schemas.v0 = require('./schemas/v0')
    return schemas.v0
  }

  if (version === 'v1') {
    schemas.v1 = require('./schemas/v1')
    return schemas.v1
  }
}

class SchemaManager {
  /**
   * @type {object}
   */
  config = {
    spanAttributeSchema: 'v0',
    spanRemoveIntegrationFromService: false,
  }

  /** @type {Record<string, SchemaDefinition | undefined>} */
  schemas = {}

  get schema () {
    return getSchema(this.schemas, this.version)
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
   * @returns {object} {name, source}
   */
  serviceName (type, kind, plugin, opts) {
    const version = this.shouldUseConsistentServiceNaming ? 'v1' : this.version
    const schema = getSchema(this.schemas, version)

    return schema.getServiceName(type, kind, plugin, { ...opts, tracerService: this.config.service })
  }

  /**
   * @param {object} config
   * @param {string} config.spanAttributeSchema
   * @param {boolean} config.spanRemoveIntegrationFromService
   * @param {string} [config.service]
   */
  configure (config) {
    this.config = config
  }
}

module.exports = new SchemaManager()
