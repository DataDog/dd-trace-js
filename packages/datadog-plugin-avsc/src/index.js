const SchemaPlugin = require('../../dd-trace/src/plugins/schema')
const SchemaExtractor = require('./schema_iterator')

class AvscPlugin extends SchemaPlugin {
  static get id () { return 'avsc' }
  static get schemaExtractor () { return SchemaExtractor }
}

module.exports = AvscPlugin
