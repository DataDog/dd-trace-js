'use strict'

class SchemaDefinition {
  constructor (schema) {
    this.schema = schema
  }

  getOpName (type, kind, plugin, opts) {
    const item = this.schema[type][kind][plugin]
    return item.opName(opts)
  }

  getServiceName (type, kind, plugin, opts) {
    const item = this.schema[type][kind][plugin]
    return item.serviceName(opts)
  }
}

module.exports = SchemaDefinition
