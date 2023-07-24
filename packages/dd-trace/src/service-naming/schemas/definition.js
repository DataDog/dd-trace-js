class SchemaDefinition {
  constructor (schema) {
    this.schema = schema
  }

  getSchemaItem (type, kind, plugin) {
    const schema = this.schema
    if (schema && schema[type] && schema[type][kind] && schema[type][kind][plugin]) {
      return schema[type][kind][plugin]
    }
  }

  getOpName (type, kind, plugin, opts) {
    const item = this.getSchemaItem(type, kind, plugin)
    return item.opName(opts)
  }

  getServiceName (type, kind, plugin, opts) {
    const item = this.getSchemaItem(type, kind, plugin)
    return item.serviceName(opts)
  }
}

module.exports = SchemaDefinition
