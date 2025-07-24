'use strict'

const { LRUCache } = require('lru-cache')
const { fnv64 } = require('../fnv')
const { Schema } = require('./schema')

const maxDepth = 10
const maxProperties = 1000
const CACHE = new LRUCache({ max: 256 })

class SchemaBuilder {
  constructor (iterator) {
    this.schema = new OpenApiSchema()
    this.iterator = iterator
    this.properties = 0
  }

  // TODO: This is only used in tests. Let's refactor the code and stop exposing the cache.
  static getCache () {
    return CACHE
  }

  static getSchemaDefinition (schema) {
    const definition = toJSON(schema)
    const id = fnv64(Buffer.from(definition, 'utf8')).toString()
    return new Schema(definition, id)
  }

  static getSchema (schemaName, iterator, builder) {
    let entry = CACHE.get(schemaName)
    if (!entry) {
      entry = (builder ?? new SchemaBuilder(iterator)).build()
      CACHE.set(schemaName, entry)
    }
    return entry
  }

  build () {
    this.iterator.iterateOverSchema(this)
    return this.schema
  }

  addProperty (schemaName, fieldName, isArray, type, description, ref, format, enumValues) {
    if (this.properties >= maxProperties) {
      return false
    }
    this.properties += 1
    let property = new OpenApiSchema.PROPERTY(type, description, ref, format, enumValues, null)
    if (isArray) {
      property = new OpenApiSchema.PROPERTY('array', null, null, null, null, property)
    }
    this.schema.components.schemas[schemaName].properties[fieldName] = property
    return true
  }

  shouldExtractSchema (schemaName, depth) {
    if (depth > maxDepth) {
      return false
    }
    if (schemaName in this.schema.components.schemas) {
      return false
    }
    this.schema.components.schemas[schemaName] = new OpenApiSchema.SCHEMA()
    return true
  }
}

class OpenApiSchema {
  openapi = '3.0.0'
  components = new OpenApiComponents()
}

OpenApiSchema.SCHEMA = class {
  type = 'object'
  properties = {}
}

OpenApiSchema.PROPERTY = class {
  constructor (type, description = null, ref = null, format = null, enumValues = null, items = null) {
    this.type = type
    this.description = description
    this.$ref = ref
    this.format = format
    this.enum = enumValues
    this.items = items
  }
}

class OpenApiComponents {
  constructor () {
    this.schemas = {}
  }
}

// This adds a single whitespace between entries without adding newlines.
// This differs from JSON.stringify and is used to align with the output
// in other platforms.
// TODO: Add tests to verify this behavior. A couple of cases are not
// covered by the existing tests.
function toJSON (value) {
  // eslint-disable-next-line eslint-rules/eslint-safe-typeof-object
  if (typeof value === 'object') {
    if (value === null) {
      return 'null'
    }
    if (Array.isArray(value)) {
      let result = '['
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== null) {
          if (i !== 0) {
            result += ', '
          }
          result += value[i] === undefined ? 'null' : toJSON(value[i])
        }
      }
      return `${result}]`
    }
    let result = '{'
    for (const [key, objectValue] of Object.entries(value)) {
      if (objectValue != null && typeof key === 'string') {
        const converted = toJSON(objectValue)
        if (converted !== undefined) {
          if (result !== '{') {
            result += ', '
          }
          result += `"${key}": ${converted}`
        }
      }
    }
    return `${result}}`
  }
  return JSON.stringify(value)
}

module.exports = {
  SchemaBuilder,
  OpenApiSchema,
}
