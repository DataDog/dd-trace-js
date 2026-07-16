'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { SchemaBuilder } = require('../../dd-trace/src/datastreams/schemas/schema_builder')
const SchemaExtractor = require('../src/schema_iterator')

describe('SchemaExtractor', () => {
  describe('protobufjs', () => {
    it('should include field comments in the extracted schema', () => {
      const descriptor = {
        fullName: '.MessageWithComments',
        fieldsArray: [
          {
            comment: 'The user name',
            name: 'name',
            type: 'string',
          },
        ],
      }

      const schemaData = SchemaBuilder.getSchemaDefinition(
        new SchemaBuilder(new SchemaExtractor(descriptor)).build()
      )
      const property = JSON.parse(schemaData.definition).components.schemas.MessageWithComments.properties.name

      assert.deepStrictEqual(property, {
        description: 'The user name',
        type: 'string',
      })
    })
  })
})
