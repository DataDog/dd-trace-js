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
  SCHEMA_TYPE,
} = require('../../dd-trace/src/constants')
const { SchemaBuilder } = require('../../dd-trace/src/datastreams/schemas/schema_builder')
const { NODE_MAJOR } = require('../../../version')
const { temporaryWarningExceptions } = require('../../dd-trace/test/setup/core')
const { loadMessage } = require('./helpers')

const BASIC_USER_SCHEMA_DEF = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'schemas/expected_user_schema.json'), 'utf8')
)
const ADVANCED_USER_SCHEMA_DEF = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'schemas/expected_advanced_user_schema.json'), 'utf8')
)

const BASIC_USER_SCHEMA_ID = '1605040621379664412'
const ADVANCED_USER_SCHEMA_ID = '919692610494986520'
function compareJson (expected, span) {
  const actual = JSON.parse(span.context()._tags[SCHEMA_DEFINITION])
  return JSON.stringify(actual) === JSON.stringify(expected)
}

describe('Plugin', () => {
  describe('avsc', function () {
    this.timeout(0)
    let tracer
    let avro
    let dateNowStub
    let mockTime = 0

    // avsc version 5.0.0 currently does not support a nodeMajor version greater than major version 24
    withVersions('avsc', ['avsc'], NODE_MAJOR >= 25 ? '>5.0.0' : '*', (version) => {
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
          return agent.load('avsc').then(() => {
            temporaryWarningExceptions.add('SlowBuffer() is deprecated. Please use Buffer.allocUnsafeSlow()')
            avro = require(`../../../versions/avsc@${version}`).get()
          })
        })

        after(() => {
          dateNowStub.restore()
          return agent.close({ ritmReset: false })
        })

        it('should serialize basic schema correctly', async () => {
          const loaded = await loadMessage(avro, 'User')
          const type = avro.parse(loaded.schema)
          const filePath = loaded.path

          tracer.trace('user.serialize', span => {
            const buf = type.toBuffer({ name: 'Alyssa', favorite_number: 256, favorite_color: null })
            fs.writeFileSync(filePath, buf)

            assert.strictEqual(span._name, 'user.serialize')

            assert.strictEqual(compareJson(BASIC_USER_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'avro')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'example.avro.User')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'serialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], BASIC_USER_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should serialize the advanced schema correctly', async () => {
          const loaded = await loadMessage(avro, 'AdvancedUser')
          const type = avro.parse(loaded.schema)
          const filePath = loaded.path

          tracer.trace('advanced_user.serialize', span => {
            const buf = type.toBuffer({
              name: 'Alyssa',
              age: 30,
              email: 'alyssa@example.com',
              height: 5.6,
              preferences: { theme: 'dark', notifications: 'enabled' },
              tags: ['vip', 'premium'],
              status: 'ACTIVE',
              profile_picture: Buffer.from('binarydata'),
              metadata: Buffer.from('metadata12345678'),
              address: { street: '123 Main St', city: 'Metropolis', zipcode: '12345' },
            })
            fs.writeFileSync(filePath, buf)

            assert.strictEqual(span._name, 'advanced_user.serialize')

            assert.strictEqual(compareJson(ADVANCED_USER_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'avro')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'example.avro.AdvancedUser')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'serialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], ADVANCED_USER_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should deserialize basic schema correctly', async () => {
          const loaded = await loadMessage(avro, 'User')
          const type = avro.parse(loaded.schema)
          const filePath = loaded.path
          const buf = type.toBuffer({ name: 'Alyssa', favorite_number: 256, favorite_color: null })
          fs.writeFileSync(filePath, buf)

          tracer.trace('user.deserialize', span => {
            type.fromBuffer(buf)

            assert.strictEqual(span._name, 'user.deserialize')

            assert.strictEqual(compareJson(BASIC_USER_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'avro')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'example.avro.User')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'deserialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], BASIC_USER_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })

        it('should deserialize advanced schema correctly', async () => {
          const loaded = await loadMessage(avro, 'AdvancedUser')
          const type = avro.parse(loaded.schema)
          const filePath = loaded.path
          const buf = type.toBuffer({
            name: 'Alyssa',
            age: 30,
            email: 'alyssa@example.com',
            height: 5.6,
            preferences: { theme: 'dark', notifications: 'enabled' },
            tags: ['vip', 'premium'],
            status: 'ACTIVE',
            profile_picture: Buffer.from('binarydata'),
            metadata: Buffer.from('metadata12345678'),
            address: { street: '123 Main St', city: 'Metropolis', zipcode: '12345' },
          })
          fs.writeFileSync(filePath, buf)

          tracer.trace('advanced_user.deserialize', span => {
            type.fromBuffer(buf)

            assert.strictEqual(span._name, 'advanced_user.deserialize')

            assert.strictEqual(compareJson(ADVANCED_USER_SCHEMA_DEF, span), true)
            assert.strictEqual(span.context()._tags[SCHEMA_TYPE], 'avro')
            assert.strictEqual(span.context()._tags[SCHEMA_NAME], 'example.avro.AdvancedUser')
            assert.strictEqual(span.context()._tags[SCHEMA_OPERATION], 'deserialization')
            assert.strictEqual(span.context()._tags[SCHEMA_ID], ADVANCED_USER_SCHEMA_ID)
            assert.strictEqual(span.context()._tags[SCHEMA_WEIGHT], 1)
          })
        })
      })
    })
  })
})
