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
const { loadMessage } = require('./helpers')
// const { SchemaBuilder } = require('../../dd-trace/src/datastreams/schemas/schema_builder')

const schemas = JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas/expected_schemas.json'), 'utf8'))
const BASIC_USER_SCHEMA_DEF = schemas.User
const ADVANCED_USER_SCHEMA_DEF = schemas.AdvancedUser

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
    let mockTime

    beforeEach(() => {
      return agent.load('avsc')
        .then(() => {
          avro = require('avsc')
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

    it('should serialize basic schema correctly', async () => {
      const loaded = await loadMessage(avro, 'User')
      const type = avro.parse(loaded.schema)
      const filePath = loaded.path

      tracer.trace('user.serialize', span => {
        const buf = type.toBuffer({ name: 'Alyssa', favorite_number: 256, favorite_color: null })
        fs.writeFileSync(filePath, buf)

        expect(span._name).to.equal('user.serialize')

        expect(compareJson(BASIC_USER_SCHEMA_DEF, span)).to.equal(true)
        expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'avro')
        expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'example.avro.User')
        expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
        expect(span.context()._tags).to.have.property(SCHEMA_ID, BASIC_USER_SCHEMA_ID)
        expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
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
          address: { street: '123 Main St', city: 'Metropolis', zipcode: '12345' }
        })
        fs.writeFileSync(filePath, buf)

        expect(span._name).to.equal('advanced_user.serialize')

        expect(compareJson(ADVANCED_USER_SCHEMA_DEF, span)).to.equal(true)
        expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'avro')
        expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'example.avro.AdvancedUser')
        expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'serialization')
        expect(span.context()._tags).to.have.property(SCHEMA_ID, ADVANCED_USER_SCHEMA_ID)
        expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
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

        expect(span._name).to.equal('user.deserialize')

        expect(compareJson(BASIC_USER_SCHEMA_DEF, span)).to.equal(true)
        expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'avro')
        expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'example.avro.User')
        expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
        expect(span.context()._tags).to.have.property(SCHEMA_ID, BASIC_USER_SCHEMA_ID)
        expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
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
        address: { street: '123 Main St', city: 'Metropolis', zipcode: '12345' }
      })
      fs.writeFileSync(filePath, buf)

      tracer.trace('advanced_user.deserialize', span => {
        type.fromBuffer(buf)

        expect(span._name).to.equal('advanced_user.deserialize')

        expect(compareJson(ADVANCED_USER_SCHEMA_DEF, span)).to.equal(true)
        expect(span.context()._tags).to.have.property(SCHEMA_TYPE, 'avro')
        expect(span.context()._tags).to.have.property(SCHEMA_NAME, 'example.avro.AdvancedUser')
        expect(span.context()._tags).to.have.property(SCHEMA_OPERATION, 'deserialization')
        expect(span.context()._tags).to.have.property(SCHEMA_ID, ADVANCED_USER_SCHEMA_ID)
        expect(span.context()._tags).to.have.property(SCHEMA_WEIGHT, 1)
      })
    })
  })
})
