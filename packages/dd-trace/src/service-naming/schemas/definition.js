'use strict'

const { identityService } = require('./util')

class SchemaDefinition {
  constructor (schema) {
    this.schema = schema
  }

  getOpName (type, kind, plugin, opts) {
    const item = this._getItem(type, kind, plugin)
    return item.opName(opts)
  }

  getServiceName (type, kind, plugin, opts) {
    const item = this._getItem(type, kind, plugin)
    return item.serviceName(opts)
  }

  _getItem (type, kind, plugin) {
    // Try to find the item in the schema
    if (this.schema[type]?.[kind]?.[plugin]) {
      return this.schema[type][kind][plugin]
    }

    // Auto-register with sensible defaults if not found
    // This eliminates the need to manually add every integration to schema files
    return this._createDefaultItem(type, kind, plugin)
  }

  _createDefaultItem (type, kind, plugin) {
    // Generate default operation names based on type and kind
    const defaultOpNames = {
      messaging: {
        producer: `${plugin}.send`,
        consumer: `${plugin}.process`,
        client: `${plugin}.command`
      },
      web: {
        server: `${plugin}.request`,
        client: `${plugin}.request`
      },
      storage: {
        client: `${plugin}.query`
      },
      graphql: {
        server: 'graphql.execute'
      },
      serverless: {
        server: `${plugin}.invoke`
      }
    }

    // Get the operation name or fall back to a generic one
    const opName = defaultOpNames[type]?.[kind] || `${plugin}.operation`

    return {
      opName: () => opName,
      serviceName: identityService  // Default to using the main service name
    }
  }
}

module.exports = SchemaDefinition
