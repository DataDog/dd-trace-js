'use strict'

class SchemaManager {
  /**
   * @type {object}
   */
  config = {
    tracing: {
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: 'v0',
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: false,
    },
  }

  schemas = {
    v0: require('./schemas/v0'),
  }

  get schema () {
    return this.schemas[this.version]
  }

  get version () {
    return this.config.tracing.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
  }

  get shouldUseConsistentServiceNaming () {
    return this.config.tracing.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED && this.version === 'v0'
  }

  /**
   * @param {string} type
   * @param {string} kind
   * @param {string} plugin
   * @param {object} opts
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
    const schema = this.shouldUseConsistentServiceNaming
      ? this.schemas.v1
      : this.schema

    return schema.getServiceName(type, kind, plugin, { ...opts, tracerService: this.config.service })
  }

  /**
   * @param {object} config
   * @param {object} config.tracing
   * @param {string} config.tracing.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
   * @param {boolean} config.tracing.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED
   * @param {string} [config.service]
   */
  configure (config) {
    const {
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: spanAttributeSchema,
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: spanRemoveIntegrationFromService,
    } = config.tracing

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
