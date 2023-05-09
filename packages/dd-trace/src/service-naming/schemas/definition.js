
function getSchemaItem (schema, type, kind, plugin) {
  return schema[type][kind][plugin]
}

function bindSchema (schema) {
  return {
    opName: (type, subType, plugin, opNameArgs) => {
      const item = getSchemaItem(schema, type, subType, plugin)
      return item.opName(opNameArgs)
    },
    serviceName: (type, subType, plugin, service, serviceNameArgs) => {
      const item = getSchemaItem(schema, type, subType, plugin)
      return item.serviceName(service, serviceNameArgs)
    }
  }
}

module.exports = bindSchema
