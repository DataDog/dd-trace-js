class SchemaDefinition {
  constructor (schema) {
    this.schema = schema
  }

  getSchemaItem (type, subType, plugin) {
    const schema = this.schema
    if (schema && schema[type] && schema[type][subType] && schema[type][subType][plugin]) {
      return schema[type][subType][plugin]
    }
  }

  getOpName (type, subType, plugin, opNameArgs) {
    const item = this.getSchemaItem(type, subType, plugin)
    return item.opName(opNameArgs)
  }

  getServiceName (type, subType, plugin, serviceNameArgs) {
    const item = this.getSchemaItem(type, subType, plugin)
    return item.serviceName(this.service, serviceNameArgs)
  }

  configure ({ service }) {
    this.service = service
  }
}

module.exports = SchemaDefinition
