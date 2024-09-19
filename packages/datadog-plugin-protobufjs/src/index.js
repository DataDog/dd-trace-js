const Plugin = require('../../dd-trace/src/plugins/plugin')
const SchemaExtractor = require('./schema_iterator')

const SERIALIZATION = 'serialization'
const DESERIALIZATION = 'deserialization'

class ProtobufjsPlugin extends Plugin {
  static get id () {
    return 'protobufjs'
  }

  constructor (...args) {
    super(...args)

    this.addSub('datadog:protobuf:serialize:start', this.handleSerializeStart.bind(this))
    this.addSub('datadog:protobuf:deserialize:finish', this.handleDeserializeFinish.bind(this))
  }

  handleSerializeStart ({ message }) {
    const activeSpan = this.tracer.scope().active()
    if (activeSpan) {
      SchemaExtractor.attachSchemaOnSpan(
        message.$type ?? message, activeSpan, SERIALIZATION, this.tracer._dataStreamsProcessor
      )
    }
  }

  handleDeserializeFinish ({ message }) {
    const activeSpan = this.tracer.scope().active()
    if (activeSpan) {
      SchemaExtractor.attachSchemaOnSpan(message.$type, activeSpan, DESERIALIZATION, this.tracer._dataStreamsProcessor)
    }
  }
}

module.exports = ProtobufjsPlugin
