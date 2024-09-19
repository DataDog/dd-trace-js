'use strict'

const fs = require('fs')
const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const path = require('path')
const {
  SCHEMA_DEFINITION,
  SCHEMA_ID,
  SCHEMA_NAME,
  SCHEMA_OPERATION,
  SCHEMA_WEIGHT,
  SCHEMA_TYPE
} = require('../../dd-trace/src/constants')
const sinon = require('sinon')

const schemas = JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas/expected_schemas.json'), 'utf8'))
const MESSAGE_SCHEMA_DEF = schemas.MESSAGE_SCHEMA_DEF
const OTHER_MESSAGE_SCHEMA_DEF = schemas.OTHER_MESSAGE_SCHEMA_DEF
const ALL_TYPES_MESSAGE_SCHEMA_DEF = schemas.ALL_TYPES_MESSAGE_SCHEMA_DEF

const MESSAGE_SCHEMA_ID = '666607144722735562'
const OTHER_MESSAGE_SCHEMA_ID = '2691489402935632768'
const ALL_TYPES_MESSAGE_SCHEMA_ID = '15890948796193489151'

function compareJson (expected, span) {
  const actual = JSON.parse(span.context()._tags[SCHEMA_DEFINITION])
  return JSON.stringify(actual) === JSON.stringify(expected)
}

describe('Plugin', () => {
  describe('protobufjs', function () {
    this.timeout(0)

    let tracer
    let protobuf
    let dateNowStub
    let mockTime

    beforeEach(() => {
      return agent.load('protobufjs')
        .then(() => {
          protobuf = require('protobufjs')
          tracer = require('../../dd-trace')
        })
    })

    before(() => {
      mockTime = Date.now()
      dateNowStub = sinon.stub(Date, 'now').callsFake(() => {
        const returnValue = mockTime
        mockTime += 50000 // Increment by 50000 ms to ensure each DSM schema is sampled
        return returnValue
      })
    })

    afterEach(() => {
      return agent.close()
    })

    after(() => {
      dateNowStub.restore()
    })

    // it('should serialize basic schema correctly', async () => {
    //   const root = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/other_message.proto')
    //   const OtherMessage = root.lookupType('OtherMessage')
    //   const message = OtherMessage.create({
    //     name: ['Alice'],
    //     age: 30
    //   })

    //   tracer.trace('other_message.serialize', span => {
    //     OtherMessage.encode(message).finish()

    //     expect(span._name).to.equal('other_message.serialize')

    //     expect(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
    //     expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
    //     expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'OtherMessage')
    //     expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
    //     expect(span.context()._tags).to.have.property(SCHEMA_ID, OTHER_MESSAGE_SCHEMA_ID)
    //     expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
    //   })
    // })

    // it('should serialize complex schema correctly', async () => {
    //   const messageProto = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/message.proto')
    //   const otherMessageProto = await protobuf.load(
    //     'packages/datadog-plugin-protobufjs/test/schemas/other_message.proto'
    //   )
    //   const Status = messageProto.lookupEnum('Status')
    //   const MyMessage = messageProto.lookupType('MyMessage')
    //   const OtherMessage = otherMessageProto.lookupType('OtherMessage')
    //   const message = MyMessage.create({
    //     id: '123',
    //     value: 'example_value',
    //     status: Status.values.ACTIVE,
    //     otherMessage: [
    //       OtherMessage.create({ name: ['Alice'], age: 30 }),
    //       OtherMessage.create({ name: ['Bob'], age: 25 })
    //     ]
    //   })

    //   tracer.trace('message_pb2.serialize', span => {
    //     MyMessage.encode(message).finish()

    //     expect(span._name).to.equal('message_pb2.serialize')

    //     expect(compareJson(MESSAGE_SCHEMA_DEF, span)).to.equal(true)
    //     expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
    //     expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'MyMessage')
    //     expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
    //     expect(span.context()._tags).to.have.property(SCHEMA_ID, MESSAGE_SCHEMA_ID)
    //     expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
    //   })
    // })

    // it('should serialize schema with all types correctly', async () => {
    //   const root = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/all_types.proto')

    //   const Status = root.lookupEnum('example.Status')
    //   const Scalars = root.lookupType('example.Scalars')
    //   const NestedMessage = root.lookupType('example.NestedMessage')
    //   const ComplexMessage = root.lookupType('example.ComplexMessage')
    //   const MainMessage = root.lookupType('example.MainMessage')

    //   // Create instances of the messages
    //   const scalarsInstance = Scalars.create({
    //     int32Field: 42,
    //     int64Field: 123456789012345,
    //     uint32Field: 123,
    //     uint64Field: 123456789012345,
    //     sint32Field: -42,
    //     sint64Field: -123456789012345,
    //     fixed32Field: 42,
    //     fixed64Field: 123456789012345,
    //     sfixed32Field: -42,
    //     sfixed64Field: -123456789012345,
    //     floatField: 3.14,
    //     doubleField: 2.718281828459,
    //     boolField: true,
    //     stringField: 'Hello, world!',
    //     bytesField: Buffer.from('bytes data')
    //   })

    //   const nestedMessageInstance = NestedMessage.create({
    //     id: 'nested_id_123',
    //     scalars: scalarsInstance
    //   })

    //   const complexMessageInstance = ComplexMessage.create({
    //     repeatedField: ['item1', 'item2', 'item3'],
    //     mapField: {
    //       key1: scalarsInstance,
    //       key2: Scalars.create({
    //         int32Field: 24,
    //         stringField: 'Another string'
    //       })
    //     }
    //   })

    //   const mainMessageInstance = MainMessage.create({
    //     status: Status.values.ACTIVE,
    //     scalars: scalarsInstance,
    //     nested: nestedMessageInstance,
    //     complex: complexMessageInstance
    //   })

    //   tracer.trace('all_types.serialize', span => {
    //     MainMessage.encode(mainMessageInstance).finish()

    //     expect(span._name).to.equal('all_types.serialize')

    //     expect(compareJson(ALL_TYPES_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
    //     expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
    //     expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'example.MainMessage')
    //     expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
    //     expect(span.context()._tags).to.have.property(SCHEMA_ID, ALL_TYPES_MESSAGE_SCHEMA_ID)
    //     expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
    //   })
    // })

    it('should deserialize basic schema correctly', async () => {
      const root = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/other_message.proto')
      const OtherMessage = root.lookupType('OtherMessage')
      const message = OtherMessage.create({
        name: ['Alice'],
        age: 30
      })

      const bytes = OtherMessage.encode(message).finish()

      tracer.trace('other_message.deserialize', span => {
        OtherMessage.decode(bytes)

        expect(span._name).to.equal('other_message.deserialize')

        expect(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
        expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
        expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'OtherMessage')
        expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
        expect(span.context()._tags).to.have.property(SCHEMA_ID, OTHER_MESSAGE_SCHEMA_ID)
        expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
      })
    })

    it('should deserialize complex schema correctly', async () => {
      const messageProto = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/message.proto')
      const otherMessageProto = await protobuf.load(
        'packages/datadog-plugin-protobufjs/test/schemas/other_message.proto'
      )
      const Status = messageProto.lookupEnum('Status')
      const MyMessage = messageProto.lookupType('MyMessage')
      const OtherMessage = otherMessageProto.lookupType('OtherMessage')
      const message = MyMessage.create({
        id: '123',
        value: 'example_value',
        status: Status.values.ACTIVE,
        otherMessage: [
          OtherMessage.create({ name: ['Alice'], age: 30 }),
          OtherMessage.create({ name: ['Bob'], age: 25 })
        ]
      })

      const bytes = MyMessage.encode(message).finish()

      tracer.trace('my_message.deserialize', span => {
        MyMessage.decode(bytes)

        expect(span._name).to.equal('my_message.deserialize')

        expect(compareJson(MESSAGE_SCHEMA_DEF, span)).to.equal(true)
        expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
        expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'MyMessage')
        expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
        expect(span.context()._tags).to.have.property(SCHEMA_ID, MESSAGE_SCHEMA_ID)
        expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
      })
    })

    it('should deserialize all types schema correctly', async () => {
      const root = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/all_types.proto')

      const Status = root.lookupEnum('example.Status')
      const Scalars = root.lookupType('example.Scalars')
      const NestedMessage = root.lookupType('example.NestedMessage')
      const ComplexMessage = root.lookupType('example.ComplexMessage')
      const MainMessage = root.lookupType('example.MainMessage')

      // Create instances of the messages
      const scalarsInstance = Scalars.create({
        int32Field: 42,
        int64Field: 123456789012345,
        uint32Field: 123,
        uint64Field: 123456789012345,
        sint32Field: -42,
        sint64Field: -123456789012345,
        fixed32Field: 42,
        fixed64Field: 123456789012345,
        sfixed32Field: -42,
        sfixed64Field: -123456789012345,
        floatField: 3.14,
        doubleField: 2.718281828459,
        boolField: true,
        stringField: 'Hello, world!',
        bytesField: Buffer.from('bytes data')
      })

      const nestedMessageInstance = NestedMessage.create({
        id: 'nested_id_123',
        scalars: scalarsInstance
      })

      const complexMessageInstance = ComplexMessage.create({
        repeatedField: ['item1', 'item2', 'item3'],
        mapField: {
          key1: scalarsInstance,
          key2: Scalars.create({
            int32Field: 24,
            stringField: 'Another string'
          })
        }
      })

      const mainMessageInstance = MainMessage.create({
        status: Status.values.ACTIVE,
        scalars: scalarsInstance,
        nested: nestedMessageInstance,
        complex: complexMessageInstance
      })

      const bytes = MainMessage.encode(mainMessageInstance).finish()

      tracer.trace('all_types.deserialize', span => {
        MainMessage.decode(bytes)

        expect(span._name).to.equal('all_types.deserialize')

        expect(compareJson(ALL_TYPES_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
        expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
        expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'example.MainMessage')
        expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
        expect(span.context()._tags).to.have.property(SCHEMA_ID, ALL_TYPES_MESSAGE_SCHEMA_ID)
        expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
      })
    })
  })
})
