'use strict'

const { expect } = require('chai')
const protobuf = require('protobufjs')
const { storage } = require('../../datadog-core')
const {
  SCHEMA_DEFINITION,
  SCHEMA_ID,
  SCHEMA_NAME,
  SCHEMA_OPERATION,
  SCHEMA_WEIGHT,
  SCHEMA_TYPE
} = require('./path/to/constants')

const MESSAGE_SCHEMA_DEF = '{"openapi": "3.0.0", "components": {"schemas": {"MyMessage": {"type": "object", "properties": {"id": {"type": "string"}, "value": {"type": "string"}, "other_message": {"$ref": "#/components/schemas/OtherMessage"}, "status": {"type": "string", "format": "enum", "enum": ["UNKNOWN", "ACTIVE", "INACTIVE", "DELETED"]}}}, "OtherMessage": {"type": "object", "properties": {"name": {"type": "string"}, "age": {"type": "integer", "format": "int32"}}}}}}'
const MESSAGE_SCHEMA_ID = '6833269440911322626'

const OTHER_MESSAGE_SCHEMA_DEF = '{"openapi": "3.0.0", "components": {"schemas": {"OtherMessage": {"type": "object", "properties": {"name": {"type": "string"}, "age": {"type": "integer", "format": "int32"}}}}}}'
const OTHER_MESSAGE_SCHEMA_ID = '2475724054364642627'

describe('Protobuf Schema Extraction', () => {
  let tracer
  let testSpans

  beforeEach(() => {
    tracer = require('../../dd-trace').init()
    testSpans = { spans: [] }
  })

  it('should serialize basic schema correctly', async () => {
    const OtherMessage = await protobuf.load('./path/to/other_message.proto')
    const message = OtherMessage.lookupType('OtherMessage').create({
      name: ['Alice'],
      age: 30
    })

    const span = tracer.startSpan('other_message.serialize')
    storage.getStore().enterWith(span)
    OtherMessage.encode(message).finish()
    span.finish()

    testSpans.spans.push(span)

    expect(testSpans.spans).to.have.lengthOf(1)
    const spanData = testSpans.spans[0]
    expect(spanData._name).to.equal('other_message.serialize')
    expect(spanData.context()._tags).to.have.property(SCHEMA_DEFINITION, OTHER_MESSAGE_SCHEMA_DEF)
    expect(spanData.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
    expect(spanData.context()._tags).to.have.property(SCHEMA_NAME, 'OtherMessage')
    expect(spanData.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
    expect(spanData.context()._tags).to.have.property(SCHEMA_ID, OTHER_MESSAGE_SCHEMA_ID)
    expect(spanData.context()._metrics).to.have.property(SCHEMA_WEIGHT, 1)
  })

  it('should serialize complex schema correctly', async () => {
    const MyMessage = await protobuf.load('./path/to/message.proto')
    const OtherMessage = await protobuf.load('./path/to/other_message.proto')
    const Status = MyMessage.lookupEnum('Status')
    const message = MyMessage.lookupType('MyMessage').create({
      id: '123',
      value: 'example_value',
      status: Status.values.ACTIVE,
      other_message: [
        OtherMessage.lookupType('OtherMessage').create({ name: ['Alice'], age: 30 }),
        OtherMessage.lookupType('OtherMessage').create({ name: ['Bob'], age: 25 })
      ]
    })

    const span = tracer.startSpan('message_pb2.serialize')
    storage.getStore().enterWith(span)
    MyMessage.encode(message).finish()
    span.finish()

    testSpans.spans.push(span)

    expect(testSpans.spans).to.have.lengthOf(1)
    const spanData = testSpans.spans[0]
    expect(spanData._name).to.equal('message_pb2.serialize')
    expect(spanData.context()._tags).to.have.property(SCHEMA_DEFINITION, MESSAGE_SCHEMA_DEF)
    expect(spanData.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
    expect(spanData.context()._tags).to.have.property(SCHEMA_NAME, 'MyMessage')
    expect(spanData.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
    expect(spanData.context()._tags).to.have.property(SCHEMA_ID, MESSAGE_SCHEMA_ID)
    expect(spanData.context()._metrics).to.have.property(SCHEMA_WEIGHT, 1)
  })

  it('should deserialize basic schema correctly', async () => {
    const OtherMessage = await protobuf.load('./path/to/other_message.proto')
    const message = OtherMessage.lookupType('OtherMessage').create({
      name: ['Alice'],
      age: 30
    })

    const bytes = OtherMessage.encode(message).finish()

    const span = tracer.startSpan('other_message.deserialize')
    storage.getStore().enterWith(span)
    OtherMessage.decode(bytes)
    span.finish()

    testSpans.spans.push(span)

    expect(testSpans.spans).to.have.lengthOf(1)
    const spanData = testSpans.spans[0]
    expect(spanData._name).to.equal('other_message.deserialize')
    expect(spanData.context()._tags).to.have.property(SCHEMA_DEFINITION, OTHER_MESSAGE_SCHEMA_DEF)
    expect(spanData.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
    expect(spanData.context()._tags).to.have.property(SCHEMA_NAME, 'OtherMessage')
    expect(spanData.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
    expect(spanData.context()._tags).to.have.property(SCHEMA_ID, OTHER_MESSAGE_SCHEMA_ID)
    expect(spanData.context()._metrics).to.have.property(SCHEMA_WEIGHT, 1)
  })

  it('should deserialize complex schema correctly', async () => {
    const MyMessage = await protobuf.load('./path/to/message.proto')
    const OtherMessage = await protobuf.load('./path/to/other_message.proto')
    const Status = MyMessage.lookupEnum('Status')
    const message = MyMessage.lookupType('MyMessage').create({
      id: '123',
      value: 'example_value',
      status: Status.values.ACTIVE,
      other_message: [
        OtherMessage.lookupType('OtherMessage').create({ name: ['Alice'], age: 30 }),
        OtherMessage.lookupType('OtherMessage').create({ name: ['Bob'], age: 25 })
      ]
    })

    const bytes = MyMessage.encode(message).finish()

    const span = tracer.startSpan('my_message.deserialize')
    storage.getStore().enterWith(span)
    MyMessage.decode(bytes)
    span.finish()

    testSpans.spans.push(span)

    expect(testSpans.spans).to.have.lengthOf(1)
    const spanData = testSpans.spans[0]
    expect(spanData._name).to.equal('my_message.deserialize')
    expect(spanData.context()._tags).to.have.property(SCHEMA_DEFINITION, MESSAGE_SCHEMA_DEF)
    expect(spanData.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
    expect(spanData.context()._tags).to.have.property(SCHEMA_NAME, 'MyMessage')
    expect(spanData.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
    expect(spanData.context()._tags).to.have.property(SCHEMA_ID, MESSAGE_SCHEMA_ID)
    expect(spanData.context()._metrics).to.have.property(SCHEMA_WEIGHT, 1)
  })
})
