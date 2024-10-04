const PROTOBUF = 'protobuf'
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

  static getTypeAndFormat (type) {
    const typeFormatMapping = {
      int32: ['integer', 'int32'],
      int64: ['integer', 'int64'],
      uint32: ['integer', 'uint32'],
      uint64: ['integer', 'uint64'],
      sint32: ['integer', 'sint32'],
      sint64: ['integer', 'sint64'],
      fixed32: ['integer', 'fixed32'],
      fixed64: ['integer', 'fixed64'],
      sfixed32: ['integer', 'sfixed32'],
      sfixed64: ['integer', 'sfixed64'],
      float: ['number', 'float'],
      double: ['number', 'double'],
      bool: ['boolean', null],
      string: ['string', null],
      bytes: ['string', 'byte'],
      Enum: ['enum', null],
      Type: ['type', null],
      map: ['map', null],
      repeated: ['array', null]
    }

    return typeFormatMapping[type] || ['string', null]
  }

  static extractProperty (field, schemaName, fieldName, builder, depth) {
    let array = false
    let description
    let ref
    let enumValues

    const resolvedType = field.resolvedType ? field.resolvedType.constructor.name : field.type

    const isRepeatedField = field.rule === 'repeated'

    let typeFormat = this.getTypeAndFormat(isRepeatedField ? 'repeated' : resolvedType)
    let type = typeFormat[0]
    let format = typeFormat[1]

    if (type === 'array') {
      array = true
      typeFormat = this.getTypeAndFormat(resolvedType)
      type = typeFormat[0]
      format = typeFormat[1]
    }

    if (type === 'type') {
      format = null
      ref = `#/components/schemas/${removeLeadingPeriod(field.resolvedType.fullName)}`
      // keep a reference to the original builder iterator since when we recurse this reference will get reset to
      // deeper schemas
      const originalSchemaExtractor = builder.iterator
      if (!this.extractSchema(field.resolvedType, builder, depth, this)) {
        return false
      }
      type = 'object'
      builder.iterator = originalSchemaExtractor
    } else if (type === 'enum') {
      enumValues = []
      let i = 0
      while (field.resolvedType.valuesById[i]) {
        enumValues.push(field.resolvedType.valuesById[i])
        i += 1
      }
    }
    return builder.addProperty(schemaName, fieldName, array, type, description, ref, format, enumValues)
  }

  static extractSchema (schema, builder, depth, extractor) {
    depth += 1
    const schemaName = removeLeadingPeriod(schema.resolvedType ? schema.resolvedType.fullName : schema.fullName)
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
      for (const field of schema.fieldsArray) {
        if (!this.extractProperty(field, schemaName, field.name, builder, depth)) {
          log.warn(`DSM: Unable to extract field with name: ${field.name} from Avro schema with name: ${schemaName}`)
        }
      }
      return true
    }
  }

  static extractSchemas (descriptor, dataStreamsProcessor) {
    const schemaName = removeLeadingPeriod(
      descriptor.resolvedType ? descriptor.resolvedType.fullName : descriptor.fullName
    )
    return dataStreamsProcessor.getSchema(schemaName, new SchemaExtractor(descriptor))
  }

  iterateOverSchema (builder) {
    this.constructor.extractSchema(this.schema, builder, 0)
  }

  static attachSchemaOnSpan (args, span, operation, tracer) {
    const { messageClass } = args
    const descriptor = messageClass.$type ?? messageClass

    if (!descriptor || !span) {
      return
    }

    if (span.context()._tags[SCHEMA_TYPE] && operation === 'serialization') {
      // we have already added a schema to this span, this call is an encode of nested schema types
      return
    }

    span.setTag(SCHEMA_TYPE, PROTOBUF)
    span.setTag(SCHEMA_NAME, removeLeadingPeriod(descriptor.fullName))
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

function removeLeadingPeriod (str) {
  // Check if the first character is a period
  if (str.charAt(0) === '.') {
    // Remove the first character
    return str.slice(1)
  }
  // Return the original string if the first character is not a period
  return str
}

module.exports = SchemaExtractor
