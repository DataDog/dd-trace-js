'use strict'

const SchemaPlugin = require('../../dd-trace/src/plugins/schema')
const SchemaExtractor = require('./schema_iterator')

class AvscPlugin extends SchemaPlugin {
  static id = 'avsc'
  static schemaExtractor = SchemaExtractor
}

module.exports = AvscPlugin
