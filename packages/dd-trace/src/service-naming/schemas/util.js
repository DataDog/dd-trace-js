function namingResolver (schema) {
  return {
    opName (type, ioDirection, plugin, opNameArgs) {
      if (schema && schema[type] && schema[type][ioDirection] && schema[type][ioDirection][plugin]) {
        return schema[type][ioDirection][plugin].opName(opNameArgs)
      }
      return 'unnamed-node-operation'
    },
    serviceName (type, ioDirection, plugin, serviceNameArgs) {
      if (schema && schema[type] && schema[type][ioDirection] && schema[type][ioDirection][plugin]) {
        return schema[type][ioDirection][plugin].serviceName(serviceNameArgs)
      }
      return 'unnamed-node-service'
    }
  }
}

module.exports = { namingResolver }
