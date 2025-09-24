'use strict'

const SchemaPlugin = require('../../dd-trace/src/plugins/schema')
const SchemaExtractor = require('./schema-iterator')

class ProtobufjsPlugin extends SchemaPlugin {
  static id = 'protobufjs'

  static schemaExtractor = SchemaExtractor
}

module.exports = ProtobufjsPlugin
