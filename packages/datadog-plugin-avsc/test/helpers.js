'use strict'

const fs = require('fs')

async function loadMessage (avro, messageTypeName) {
  if (messageTypeName === 'User') {
    // Read and parse the Avro schema
    const schema = JSON.parse(fs.readFileSync('packages/datadog-plugin-avsc/test/schemas/user.avsc', 'utf8'))

    // Create a file and write Avro data
    const filePath = 'packages/datadog-plugin-avsc/test/schemas/users.avro'

    return {
      schema,
      path: filePath
    }
  } else if (messageTypeName === 'AdvancedUser') {
    // Read and parse the Avro schema
    const schema = JSON.parse(fs.readFileSync('packages/datadog-plugin-avsc/test/schemas/advanced-user.avsc', 'utf8'))

    // Create a file and write Avro data
    const filePath = 'packages/datadog-plugin-avsc/test/schemas/advanced-users.avro'

    return {
      schema,
      path: filePath
    }
  }
}

module.exports = {
  loadMessage
}
