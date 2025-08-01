'use strict'

const SchemaPlugin = require('../../dd-trace/src/plugins/schema')
const SchemaExtractor = require('./schema_iterator')

class ProtobufjsPlugin extends SchemaPlugin {
  static id = 'protobufjs'

  static schemaExtractor = SchemaExtractor
}

module.exports = ProtobufjsPlugin
