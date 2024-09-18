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
    this.addSub('datadog:protobuf:serialize:finish', this.handleSerializeFinish.bind(this))
    this.addSub('datadog:protobuf:deserialize:start', this.handleDeserializeStart.bind(this))
    this.addSub('datadog:protobuf:deserialize:finish', this.handleDeserializeFinish.bind(this))
  }

  handleSerializeStart ({ message }) {
    const activeSpan = this.tracer.scope().active()
    if (activeSpan) {
      SchemaExtractor.attachSchemaOnSpan(message, activeSpan, SERIALIZATION, this.tracer._dataStreamsProcessor)
    }
  }

  handleSerializeFinish ({ message }) {
    const activeSpan = this.tracer.scope().active()
    if (activeSpan) {
      // Perform additional DSM checks or schema extraction here if needed
    }
  }

  handleDeserializeStart ({ buffer }) {
    // const activeSpan = this.tracer.scope().active()
    // if (activeSpan) {
    //   SchemaExtractor.attachSchemaOnSpan(buffer, activeSpan, DESERIALIZATION)
    // }
  }

  handleDeserializeFinish ({ message }) {
    const activeSpan = this.tracer.scope().active()
    if (activeSpan) {
      SchemaExtractor.attachSchemaOnSpan(message.$type, activeSpan, DESERIALIZATION, this.tracer._dataStreamsProcessor)
    }
  }
}

module.exports = ProtobufjsPlugin
