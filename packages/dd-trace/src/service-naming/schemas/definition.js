class SchemaDefinition {
  constructor (schema) {
    this.schema = schema
  }

  getSchemaItem (type, ioDirection, plugin) {
    const schema = this.schema
    if (schema && schema[type] && schema[type][ioDirection] && schema[type][ioDirection][plugin]) {
      return schema[type][ioDirection][plugin]
    }
  }

  getOpName (type, ioDirection, plugin, opNameArgs) {
    const item = this.getSchemaItem(type, ioDirection, plugin)
    return item.opName(opNameArgs)
  }

  getServiceName (type, ioDirection, plugin, service, serviceNameArgs) {
    const item = this.getSchemaItem(type, ioDirection, plugin)
    return item.serviceName(service, serviceNameArgs)
  }
}

module.exports = SchemaDefinition
