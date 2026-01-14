'use strict'

const fs = require('fs')
const assert = require('node:assert/strict')
const path = require('path')

const sinon = require('sinon')
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
const { SchemaBuilder } = require('../../dd-trace/src/datastreams/schemas/schema_builder')
const { loadMessage } = require('./helpers')

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

            assert.strictEqual(span._name, 'other_message.serialize')

            assert.strictEqual(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'OtherMessage')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'serialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], OTHER_MESSAGE_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should load using a callback instead of promise', async () => {
          const loadedMessages = loadMessage(protobuf, 'OtherMessage', () => {
            tracer.trace('other_message.serialize', span => {
              loadedMessages.OtherMessage.type.encode(loadedMessages.OtherMessage.instance).finish()

              assert.strictEqual(span._name, 'other_message.serialize')

              assert.strictEqual(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span), true)
              assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
              assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'OtherMessage')
              assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'serialization')
              assert.strictEqual(span.context()._tags[SCHEMA_ID], OTHER_MESSAGE_SCHEMA_ID)
              assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
            })
          })
        })

        it('should serialize complex schema correctly', async () => {
          const loadedMessages = await loadMessage(protobuf, 'MyMessage')

          tracer.trace('message_pb2.serialize', span => {
            loadedMessages.MyMessage.type.encode(loadedMessages.MyMessage.instance).finish()

            assert.strictEqual(span._name, 'message_pb2.serialize')

            assert.strictEqual(compareJson(MESSAGE_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'MyMessage')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'serialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], MESSAGE_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should serialize schema with all types correctly', async () => {
          const loadedMessages = await loadMessage(protobuf, 'MainMessage')

          tracer.trace('all_types.serialize', span => {
            loadedMessages.MainMessage.type.encode(loadedMessages.MainMessage.instance).finish()

            assert.strictEqual(span._name, 'all_types.serialize')

            assert.strictEqual(compareJson(ALL_TYPES_MESSAGE_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'example.MainMessage')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'serialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], ALL_TYPES_MESSAGE_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should deserialize basic schema correctly', async () => {
          const loadedMessages = await loadMessage(protobuf, 'OtherMessage')

          const bytes = loadedMessages.OtherMessage.type.encode(loadedMessages.OtherMessage.instance).finish()

          tracer.trace('other_message.deserialize', span => {
            loadedMessages.OtherMessage.type.decode(bytes)

            assert.strictEqual(span._name, 'other_message.deserialize')

            assert.strictEqual(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'OtherMessage')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'deserialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], OTHER_MESSAGE_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should deserialize complex schema correctly', async () => {
          const loadedMessages = await loadMessage(protobuf, 'MyMessage')

          const bytes = loadedMessages.MyMessage.type.encode(loadedMessages.MyMessage.instance).finish()

          tracer.trace('my_message.deserialize', span => {
            loadedMessages.MyMessage.type.decode(bytes)

            assert.strictEqual(span._name, 'my_message.deserialize')

            assert.strictEqual(compareJson(MESSAGE_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'MyMessage')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'deserialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], MESSAGE_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should deserialize all types schema correctly', async () => {
          const loadedMessages = await loadMessage(protobuf, 'MainMessage')

          const bytes = loadedMessages.MainMessage.type.encode(loadedMessages.MainMessage.instance).finish()

          tracer.trace('all_types.deserialize', span => {
            loadedMessages.MainMessage.type.decode(bytes)

            assert.strictEqual(span._name, 'all_types.deserialize')

            assert.strictEqual(compareJson(ALL_TYPES_MESSAGE_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'example.MainMessage')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'deserialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], ALL_TYPES_MESSAGE_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should wrap encode and decode for fromObject', async () => {
          const root = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/other_message.proto')
          const OtherMessage = root.lookupType('OtherMessage')
          const messageObject = {
            name: ['Alice'],
            age: 30
          }
          const message = OtherMessage.fromObject(messageObject)

          const bytes = OtherMessage.encode(message).finish()

          tracer.trace('other_message.deserialize', span => {
            OtherMessage.decode(bytes)

            assert.strictEqual(span._name, 'other_message.deserialize')

            assert.strictEqual(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'OtherMessage')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'deserialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], OTHER_MESSAGE_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should wrap decodeDelimited', async () => {
          const root = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/other_message.proto')
          const OtherMessage = root.lookupType('OtherMessage')
          const message = OtherMessage.create({
            name: ['Alice'],
            age: 30
          })

          const bytes = OtherMessage.encodeDelimited(message).finish()

          tracer.trace('other_message.deserialize', span => {
            OtherMessage.decodeDelimited(bytes)

            assert.strictEqual(span._name, 'other_message.deserialize')

            assert.strictEqual(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'OtherMessage')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'deserialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], OTHER_MESSAGE_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
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

            assert.strictEqual(span._name, 'other_message.deserialize')

            assert.strictEqual(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'OtherMessage')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'deserialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], OTHER_MESSAGE_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should load using JSON descriptors', () => {
          const jsonDescriptor = require('./schemas/other_message_proto.json')
          const root = protobuf.Root.fromJSON(jsonDescriptor)
          const OtherMessage = root.lookupType('OtherMessage')

          const message = OtherMessage.create({
            name: ['Alice'],
            age: 30
          })

          const bytes = OtherMessage.encodeDelimited(message).finish()

          tracer.trace('other_message.deserialize', span => {
            OtherMessage.decodeDelimited(bytes)

            assert.strictEqual(span._name, 'other_message.deserialize')

            assert.strictEqual(compareJson(OTHER_MESSAGE_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'OtherMessage')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'deserialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], OTHER_MESSAGE_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
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

              assert.strictEqual(span._name, 'message_pb2.serialize')

              assert.strictEqual(compareJson(MESSAGE_SCHEMA_DEF, span), true)
              assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
              assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'MyMessage')
              assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'serialization')
              assert.strictEqual(span.context()._tags[SCHEMA_ID], MESSAGE_SCHEMA_ID)
              assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)

              // we sampled 1 schema with 1 subschema, so the constructor should've only been called twice
              assert.strictEqual(cacheSetSpy.callCount, 2)
              assert.strictEqual(cacheGetSpy.callCount, 2)
            })

            tracer.trace('message_pb2.serialize', span => {
              loadedMessages.MyMessage.type.encode(loadedMessages.MyMessage.instance).finish()

              assert.strictEqual(span._name, 'message_pb2.serialize')

              assert.strictEqual(compareJson(MESSAGE_SCHEMA_DEF, span), true)
              assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'protobuf')
              assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'MyMessage')
              assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'serialization')
              assert.strictEqual(span.context()._tags[SCHEMA_ID], MESSAGE_SCHEMA_ID)
              assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)

              // ensure schema was sampled and returned via the cache, so no extra cache set
              // calls were needed, only gets
              assert.strictEqual(cacheSetSpy.callCount, 2)
              assert.strictEqual(cacheGetSpy.callCount, 3)
            })
          })
        })
      })
    })
  })
})
