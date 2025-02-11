const AVRO = 'avro'
const {
  SCHEMA_DEFINITION,
  SCHEMA_ID,
  SCHEMA_NAME,
  SCHEMA_OPERATION,
  SCHEMA_WEIGHT,
  SCHEMA_TYPE
} = require('../../dd-trace/src/constants')
const log = require('../../dd-trace/src/log')
const {
  SchemaBuilder
} = require('../../dd-trace/src/datastreams/schemas/schema_builder')

class SchemaExtractor {
  constructor (schema) {
    this.schema = schema
  }

  static getType (type) {
    const typeMapping = {
      string: 'string',
      int: 'integer',
      long: 'integer',
      float: 'number',
      double: 'number',
      boolean: 'boolean',
      bytes: 'string',
      record: 'object',
      enum: 'string',
      array: 'array',
      map: 'object',
      fixed: 'string'
    }
    const typeName = type.typeName ?? type.name ?? type
    return typeName === 'null' ? typeName : typeMapping[typeName] || 'string'
  }

  static extractProperty (field, schemaName, fieldName, builder, depth) {
    let array = false
    let type
    let format
    let enumValues
    let description
    let ref

    const fieldType = field.type?.types ?? field.type?.typeName ?? field.type

    if (Array.isArray(fieldType)) {
      // Union Type
      type = 'union[' + fieldType.map(t => SchemaExtractor.getType(t.type || t)).join(',') + ']'
    } else if (fieldType === 'array') {
      // Array Type
      array = true
      const nestedType = field.type.itemsType.typeName
      type = SchemaExtractor.getType(nestedType)
    } else if (fieldType === 'record') {
      // Nested Record Type
      type = 'object'
      ref = `#/components/schemas/${field.type.name}`
      if (!SchemaExtractor.extractSchema(field.type, builder, depth + 1, this)) {
        return false
      }
    } else if (fieldType === 'enum') {
      enumValues = []
      let i = 0
      type = 'string'
      while (field.type.symbols[i]) {
        enumValues.push(field.type.symbols[i])
        i += 1
      }
    } else {
      // Primitive type
      type = SchemaExtractor.getType(fieldType.type || fieldType)
      if (fieldType === 'bytes') {
        format = 'byte'
      } else if (fieldType === 'int') {
        format = 'int32'
      } else if (fieldType === 'long') {
        format = 'int64'
      } else if (fieldType === 'float') {
        format = 'float'
      } else if (fieldType === 'double') {
        format = 'double'
      }
    }

    return builder.addProperty(schemaName, fieldName, array, type, description, ref, format, enumValues)
  }

  static extractSchema (schema, builder, depth, extractor) {
    depth += 1
    const schemaName = schema.name
    if (extractor) {
      // if we already have a defined extractor, this is a nested schema. create a new extractor for the nested
      // schema, ensure it is added to our schema builder's cache, and replace the builders iterator with our
      // nested schema iterator / extractor. Once complete, add the new schema to our builder's schemas.
      const nestedSchemaExtractor = new SchemaExtractor(schema)
      builder.iterator = nestedSchemaExtractor
      const nestedSchema = SchemaBuilder.getSchema(schemaName, nestedSchemaExtractor, builder)
      for (const nestedSubSchemaName in nestedSchema.components.schemas) {
        if (nestedSchema.components.schemas.hasOwnProperty(nestedSubSchemaName)) {
          builder.schema.components.schemas[nestedSubSchemaName] = nestedSchema.components.schemas[nestedSubSchemaName]
        }
      }
      return true
    } else {
      if (!builder.shouldExtractSchema(schemaName, depth)) {
        return false
      }
      if (schema.fields?.[Symbol.iterator]) {
        for (const field of schema.fields) {
          if (!this.extractProperty(field, schemaName, field.name, builder, depth)) {
            log.warn('DSM: Unable to extract field with name: %s from Avro schema with name: %s', field.name,
              schemaName)
          }
        }
      } else {
        log.warn('DSM: schema.fields is not iterable from Avro schema with name: %s', schemaName)
      }
    }
    return true
  }

  static extractSchemas (descriptor, dataStreamsProcessor) {
    return dataStreamsProcessor.getSchema(descriptor.name, new SchemaExtractor(descriptor))
  }

  iterateOverSchema (builder) {
    this.constructor.extractSchema(this.schema, builder, 0)
  }

  static attachSchemaOnSpan (args, span, operation, tracer) {
    const { messageClass } = args
    const descriptor = messageClass?.constructor?.type ?? messageClass

    if (!descriptor || !span) {
      return
    }

    if (span.context()._tags[SCHEMA_TYPE] && operation === 'serialization') {
      // we have already added a schema to this span, this call is an encode of nested schema types
      return
    }

    span.setTag(SCHEMA_TYPE, AVRO)
    span.setTag(SCHEMA_NAME, descriptor.name)
    span.setTag(SCHEMA_OPERATION, operation)

    if (!tracer._dataStreamsProcessor.canSampleSchema(operation)) {
      return
    }

    // if the span is unsampled, do not sample the schema
    if (!tracer._prioritySampler.isSampled(span)) {
      return
    }

    const weight = tracer._dataStreamsProcessor.trySampleSchema(operation)
    if (weight === 0) {
      return
    }

    const schemaData = SchemaBuilder.getSchemaDefinition(
      this.extractSchemas(descriptor, tracer._dataStreamsProcessor)
    )

    span.setTag(SCHEMA_DEFINITION, schemaData.definition)
    span.setTag(SCHEMA_WEIGHT, weight)
    span.setTag(SCHEMA_ID, schemaData.id)
  }
}

module.exports = SchemaExtractor
