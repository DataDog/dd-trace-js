
function getSchemaItem (schema, type, kind, plugin) {
  if (schema && schema[type] && schema[type][kind] && schema[type][kind][plugin]) {
    return schema[type][kind][plugin]
  }
}

function bindSchema (schema) {
  return {
    getOpName: (type, subType, plugin, opNameArgs) => {
      const item = getSchemaItem(schema, type, subType, plugin)
      return item.opName(opNameArgs)
    },
    getServiceName: (type, subType, plugin, service, serviceNameArgs) => {
      const item = getSchemaItem(schema, type, subType, plugin)
      return item.serviceName(service, serviceNameArgs)
    }
  }
}

module.exports = bindSchema
