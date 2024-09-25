const SchemaPlugin = require('../../dd-trace/src/plugins/schema')
const SchemaExtractor = require('./schema_iterator')

class ProtobufjsPlugin extends SchemaPlugin {
  static get id () {
    return 'protobufjs'
  }

  static get schemaExtractor () {
    return SchemaExtractor
  }
}

module.exports = ProtobufjsPlugin
