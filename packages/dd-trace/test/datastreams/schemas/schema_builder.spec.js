'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha

require('../../setup/core')

const { SchemaBuilder } = require('../../../src/datastreams/schemas/schema_builder')

class Iterator {
  iterateOverSchema (builder) {
    builder.addProperty('person', 'name', false, 'string', 'name of the person', null, null, null)
    builder.addProperty('person', 'phone_numbers', true, 'string', null, null, null, null)
    builder.addProperty('person', 'person_name', false, 'string', null, null, null, null)
    builder.addProperty('person', 'address', false, 'object', null, '#/components/schemas/address', null, null)
    builder.addProperty('address', 'zip', false, 'number', null, null, 'int', null)
    builder.addProperty('address', 'street', false, 'string', null, null, null, null)
  }
}

describe('SchemaBuilder', () => {
  it('should convert schema correctly to JSON', () => {
    const builder = new SchemaBuilder(new Iterator())

    const shouldExtractPerson = builder.shouldExtractSchema('person', 0)
    const shouldExtractAddress = builder.shouldExtractSchema('address', 1)
    const shouldExtractPerson2 = builder.shouldExtractSchema('person', 0)
    const shouldExtractTooDeep = builder.shouldExtractSchema('city', 11)
    const schema = SchemaBuilder.getSchemaDefinition(builder.build())

    const expectedSchema = {
      components: {
        schemas: {
          person: {
            properties: {
              name: { description: 'name of the person', type: 'string' },
              phone_numbers: { items: { type: 'string' }, type: 'array' },
              person_name: { type: 'string' },
              address: { $ref: '#/components/schemas/address', type: 'object' }
            },
            type: 'object'
          },
          address: {
            properties: { zip: { format: 'int', type: 'number' }, street: { type: 'string' } },
            type: 'object'
          }
        }
      },
      openapi: '3.0.0'
    }

    expect(JSON.parse(schema.definition)).to.deep.equal(expectedSchema)
    expect(schema.id).to.equal('9510078321201428652')
    expect(shouldExtractPerson).to.be.true
    expect(shouldExtractAddress).to.be.true
    expect(shouldExtractPerson2).to.be.false
    expect(shouldExtractTooDeep).to.be.false
  })
})
