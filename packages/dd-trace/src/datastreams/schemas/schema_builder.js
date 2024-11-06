const LRUCache = require('lru-cache')
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

  static getCache () {
    return CACHE
  }

  static getSchemaDefinition (schema) {
    const noNones = convertToJsonCompatible(schema)
    const definition = jsonStringify(noNones)
    const id = fnv64(Buffer.from(definition, 'utf-8')).toString()
    return new Schema(definition, id)
  }

  static getSchema (schemaName, iterator, builder) {
    if (!CACHE.has(schemaName)) {
      CACHE.set(schemaName, (builder ?? new SchemaBuilder(iterator)).build())
    }
    return CACHE.get(schemaName)
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
  constructor () {
    this.openapi = '3.0.0'
    this.components = new OpenApiComponents()
  }
}

OpenApiSchema.SCHEMA = class {
  constructor () {
    this.type = 'object'
    this.properties = {}
  }
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

function convertToJsonCompatible (obj) {
  if (Array.isArray(obj)) {
    return obj.filter(item => item !== null).map(item => convertToJsonCompatible(item))
  } else if (obj && typeof obj === 'object') {
    const jsonObj = {}
    for (const [key, value] of Object.entries(obj)) {
      if (value !== null) {
        jsonObj[key] = convertToJsonCompatible(value)
      }
    }
    return jsonObj
  }
  return obj
}

function convertKey (key) {
  if (key === 'enumValues') {
    return 'enum'
  }
  return key
}

function jsonStringify (obj, indent = 2) {
  // made to stringify json exactly similar to python / java in order for hashing to be the same
  const jsonString = JSON.stringify(obj, (_, value) => value, indent)
  return jsonString.replace(/^ +/gm, ' ') // Replace leading spaces with single space
    .replace(/\n/g, '') // Remove newlines
    .replace(/{ /g, '{') // Remove space after '{'
    .replace(/ }/g, '}') // Remove space before '}'
    .replace(/\[ /g, '[') // Remove space after '['
    .replace(/ \]/g, ']') // Remove space before ']'
}

module.exports = {
  SchemaBuilder,
  OpenApiSchema,
  convertToJsonCompatible,
  convertKey
}
