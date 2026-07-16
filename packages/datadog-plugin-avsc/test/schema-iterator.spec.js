'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { SchemaBuilder } = require('../../dd-trace/src/datastreams/schemas/schema_builder')
const SchemaExtractor = require('../src/schema_iterator')

describe('SchemaExtractor', () => {
  describe('avsc', () => {
    it('should include field docs in the extracted schema', () => {
      const schema = {
        name: 'UserWithDocs',
        fields: [
          {
            name: 'name',
            type: 'string',
            doc: 'The user name',
          },
        ],
      }

      const schemaData = SchemaBuilder.getSchemaDefinition(
        new SchemaBuilder(new SchemaExtractor(schema)).build()
      )
      const property = JSON.parse(schemaData.definition).components.schemas.UserWithDocs.properties.name

      assert.deepStrictEqual(property, {
        description: 'The user name',
        type: 'string',
      })
    })
  })
})
