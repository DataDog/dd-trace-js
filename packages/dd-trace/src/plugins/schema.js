'use strict'

const Plugin = require('./plugin')

const SERIALIZATION = 'serialization'
const DESERIALIZATION = 'deserialization'

class SchemaPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.id}:serialize-start`, this.handleSerializeStart.bind(this))
    this.addSub(`apm:${this.constructor.id}:deserialize-end`, this.handleDeserializeFinish.bind(this))
  }

  handleSerializeStart (args) {
    const activeSpan = this.tracer.scope().active()
    if (activeSpan && this.config.dsmEnabled) {
      this.constructor.schemaExtractor.attachSchemaOnSpan(
        args, activeSpan, SERIALIZATION, this.tracer
      )
    }
  }

  handleDeserializeFinish (args) {
    const activeSpan = this.tracer.scope().active()
    if (activeSpan && this.config.dsmEnabled) {
      this.constructor.schemaExtractor.attachSchemaOnSpan(
        args, activeSpan, DESERIALIZATION, this.tracer
      )
    }
  }
}

module.exports = SchemaPlugin
