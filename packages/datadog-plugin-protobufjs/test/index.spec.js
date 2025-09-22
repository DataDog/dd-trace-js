'use strict'

const fs = require('fs')
const path = require('path')
const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const {
  SCHEMA_DEFINITION,
  SCHEMA_ID,
  SCHEMA_NAME,
  SCHEMA_OPERATION,
  SCHEMA_WEIGHT,
  SCHEMA_TYPE
} = require('../../dd-trace/src/constants')
const sinon = require('sinon')
const { loadMessage } = require('./helpers')
const { SchemaBuilder } = require('../../dd-trace/src/datastreams/schemas/schema-builder')

const schemas = JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas/expected-schemas.json'), 'utf8'))
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
    let tracer
    let protobuf
    let dateNowStub
    let mockTime = 0

    withVersions('protobufjs', ['protobufjs'], (version) => {
      before(() => {
        tracer = require('../../dd-trace').init()
        // reset sampled schemas
        if (tracer._dataStreamsProcessor?._schemaSamplers) {
          tracer._dataStreamsProcessor._schemaSamplers = []
        }
      })

      describe('without configuration', () => {
        before(() => {
          dateNowStub = sinon.stub(Date, 'now').callsFake(() => {
            const returnValue = mockTime
            mockTime += 50000 // Increment by 50000 ms to ensure each DSM schema is sampled
            return returnValue
          })
          const cache = SchemaBuilder.getCache()
          cache.clear()
          return agent.load('protobufjs').then(() => {
            protobuf = require(`../../../versions/protobufjs@${version}`).get()
          })
        })

        after(() => {
          dateNowStub.restore()
          return agent.close({ ritmReset: false })
        })

        it('should serialize basic schema correctly', async () => {
          const loadedMessages = await loadMessage(protobuf, 'OtherMessage')

          tracer.trace('other_message.serialize', span => {
            loadedMessages.OtherMessage.type.encode(loadedMessages.OtherMessage.instance).finish()

            expect(span._name).to.equal('other_message.serialize')

            expect(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
            expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
            expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'OtherMessage')
            expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
            expect(span.context()._tags).to.have.property(SCHEMA_ID, OTHER_MESSAGE_SCHEMA_ID)
            expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
          })
        })

        it('should load using a callback instead of promise', async () => {
          const loadedMessages = loadMessage(protobuf, 'OtherMessage', () => {
            tracer.trace('other_message.serialize', span => {
              loadedMessages.OtherMessage.type.encode(loadedMessages.OtherMessage.instance).finish()

              expect(span._name).to.equal('other_message.serialize')

              expect(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
              expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
              expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'OtherMessage')
              expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
              expect(span.context()._tags).to.have.property(SCHEMA_ID, OTHER_MESSAGE_SCHEMA_ID)
              expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
            })
          })
        })

        it('should serialize complex schema correctly', async () => {
          const loadedMessages = await loadMessage(protobuf, 'MyMessage')

          tracer.trace('message_pb2.serialize', span => {
            loadedMessages.MyMessage.type.encode(loadedMessages.MyMessage.instance).finish()

            expect(span._name).to.equal('message_pb2.serialize')

            expect(compareJson(MESSAGE_SCHEMA_DEF, span)).to.equal(true)
            expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
            expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'MyMessage')
            expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
            expect(span.context()._tags).to.have.property(SCHEMA_ID, MESSAGE_SCHEMA_ID)
            expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
          })
        })

        it('should serialize schema with all types correctly', async () => {
          const loadedMessages = await loadMessage(protobuf, 'MainMessage')

          tracer.trace('all_types.serialize', span => {
            loadedMessages.MainMessage.type.encode(loadedMessages.MainMessage.instance).finish()

            expect(span._name).to.equal('all_types.serialize')

            expect(compareJson(ALL_TYPES_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
            expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
            expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'example.MainMessage')
            expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
            expect(span.context()._tags).to.have.property(SCHEMA_ID, ALL_TYPES_MESSAGE_SCHEMA_ID)
            expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
          })
        })

        it('should deserialize basic schema correctly', async () => {
          const loadedMessages = await loadMessage(protobuf, 'OtherMessage')

          const bytes = loadedMessages.OtherMessage.type.encode(loadedMessages.OtherMessage.instance).finish()

          tracer.trace('other_message.deserialize', span => {
            loadedMessages.OtherMessage.type.decode(bytes)

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
          const loadedMessages = await loadMessage(protobuf, 'MyMessage')

          const bytes = loadedMessages.MyMessage.type.encode(loadedMessages.MyMessage.instance).finish()

          tracer.trace('my_message.deserialize', span => {
            loadedMessages.MyMessage.type.decode(bytes)

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
          const loadedMessages = await loadMessage(protobuf, 'MainMessage')

          const bytes = loadedMessages.MainMessage.type.encode(loadedMessages.MainMessage.instance).finish()

          tracer.trace('all_types.deserialize', span => {
            loadedMessages.MainMessage.type.decode(bytes)

            expect(span._name).to.equal('all_types.deserialize')

            expect(compareJson(ALL_TYPES_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
            expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
            expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'example.MainMessage')
            expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
            expect(span.context()._tags).to.have.property(SCHEMA_ID, ALL_TYPES_MESSAGE_SCHEMA_ID)
            expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
          })
        })

        it('should wrap encode and decode for fromObject', async () => {
          const root = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/other-message.proto')
          const OtherMessage = root.lookupType('OtherMessage')
          const messageObject = {
            name: ['Alice'],
            age: 30
          }
          const message = OtherMessage.fromObject(messageObject)

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

        it('should wrap decodeDelimited', async () => {
          const root = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/other-message.proto')
          const OtherMessage = root.lookupType('OtherMessage')
          const message = OtherMessage.create({
            name: ['Alice'],
            age: 30
          })

          const bytes = OtherMessage.encodeDelimited(message).finish()

          tracer.trace('other_message.deserialize', span => {
            OtherMessage.decodeDelimited(bytes)

            expect(span._name).to.equal('other_message.deserialize')

            expect(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
            expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
            expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'OtherMessage')
            expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
            expect(span.context()._tags).to.have.property(SCHEMA_ID, OTHER_MESSAGE_SCHEMA_ID)
            expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
          })
        })

        it('should load using direct type creation', () => {
          const OtherMessage = new protobuf.Type('OtherMessage')
            .add(new protobuf.Field('name', 1, 'string', 'repeated'))
            .add(new protobuf.Field('age', 2, 'int32'))

          const message = OtherMessage.create({
            name: ['Alice'],
            age: 30
          })

          const bytes = OtherMessage.encodeDelimited(message).finish()

          tracer.trace('other_message.deserialize', span => {
            OtherMessage.decodeDelimited(bytes)

            expect(span._name).to.equal('other_message.deserialize')

            expect(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
            expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
            expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'OtherMessage')
            expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
            expect(span.context()._tags).to.have.property(SCHEMA_ID, OTHER_MESSAGE_SCHEMA_ID)
            expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
          })
        })

        it('should load using JSON descriptors', () => {
          const jsonDescriptor = require('./schemas/other-message-proto.json')
          const root = protobuf.Root.fromJSON(jsonDescriptor)
          const OtherMessage = root.lookupType('OtherMessage')

          const message = OtherMessage.create({
            name: ['Alice'],
            age: 30
          })

          const bytes = OtherMessage.encodeDelimited(message).finish()

          tracer.trace('other_message.deserialize', span => {
            OtherMessage.decodeDelimited(bytes)

            expect(span._name).to.equal('other_message.deserialize')

            expect(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span)).to.equal(true)
            expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
            expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'OtherMessage')
            expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
            expect(span.context()._tags).to.have.property(SCHEMA_ID, OTHER_MESSAGE_SCHEMA_ID)
            expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
          })
        })

        describe('during schema sampling', function () {
          let cacheSetSpy
          let cacheGetSpy

          beforeEach(() => {
            const cache = SchemaBuilder.getCache()
            cache.clear()
            cacheSetSpy = sinon.spy(cache, 'set')
            cacheGetSpy = sinon.spy(cache, 'get')
          })

          afterEach(() => {
            cacheSetSpy.restore()
            cacheGetSpy.restore()
          })

          it('should use the schema cache and not re-extract an already sampled schema', async () => {
            const loadedMessages = await loadMessage(protobuf, 'MyMessage')

            tracer.trace('message_pb2.serialize', span => {
              loadedMessages.MyMessage.type.encode(loadedMessages.MyMessage.instance).finish()

              expect(span._name).to.equal('message_pb2.serialize')

              expect(compareJson(MESSAGE_SCHEMA_DEF, span)).to.equal(true)
              expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
              expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'MyMessage')
              expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
              expect(span.context()._tags).to.have.property(SCHEMA_ID, MESSAGE_SCHEMA_ID)
              expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)

              // we sampled 1 schema with 1 subschema, so the constructor should've only been called twice
              expect(cacheSetSpy.callCount).to.equal(2)
              expect(cacheGetSpy.callCount).to.equal(2)
            })

            tracer.trace('message_pb2.serialize', span => {
              loadedMessages.MyMessage.type.encode(loadedMessages.MyMessage.instance).finish()

              expect(span._name).to.equal('message_pb2.serialize')

              expect(compareJson(MESSAGE_SCHEMA_DEF, span)).to.equal(true)
              expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'protobuf')
              expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'MyMessage')
              expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
              expect(span.context()._tags).to.have.property(SCHEMA_ID, MESSAGE_SCHEMA_ID)
              expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)

              // ensure schema was sampled and returned via the cache, so no extra cache set
              // calls were needed, only gets
              expect(cacheSetSpy.callCount).to.equal(2)
              expect(cacheGetSpy.callCount).to.equal(3)
            })
          })
        })
      })
    })
  })
})
