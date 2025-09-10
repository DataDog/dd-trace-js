'use strict'

/**
 * APM Data Requirements Specification
 *
 * Generic, reusable specification for APM integration data requirements.
 * Can be used by:
 * - Code analyzers to score instrumentation targets
 * - Test agents to validate span data completeness
 * - Scaffolding tools to generate appropriate instrumentation
 * - Documentation generators for integration guides
 */

/**
 * Span field mappings for different integration types
 * Maps conceptual data requirements to actual span tag names
 */
const SPAN_FIELD_MAPPINGS = {
  'http-client': {
    url: ['http.url', 'http.target', 'url.full'],
    method: ['http.method', 'http.request.method'],
    headers: ['http.request.headers.*', 'http.headers.*'],
    timeout: ['http.timeout', 'http.client.timeout'],
    status_code: ['http.status_code', 'http.response.status_code'],
    host: ['net.peer.name', 'server.address', 'out.host'],
    port: ['net.peer.port', 'server.port', 'out.port'],
    user_agent: ['http.user_agent', 'user_agent.original']
  },

  'http-server': {
    url: ['http.url', 'http.target', 'url.path'],
    method: ['http.method', 'http.request.method'],
    headers: ['http.request.headers.*', 'http.headers.*'],
    status_code: ['http.status_code', 'http.response.status_code'],
    route: ['http.route', 'route.pattern', 'resource.name'],
    handler: ['http.handler', 'handler.name'],
    middleware: ['middleware.name', 'middleware.type'],
    request_size: ['http.request.content_length', 'http.request_content_length'],
    response_size: ['http.response.content_length', 'http.response_content_length']
  },

  'database-client': {
    query: ['db.statement', 'db.query.text', 'resource.name'],
    database: ['db.name', 'db.namespace'],
    host: ['net.peer.name', 'server.address', 'out.host'],
    port: ['net.peer.port', 'server.port', 'out.port'],
    user: ['db.user', 'db.username'],
    system: ['db.system', 'db.type'],
    operation: ['db.operation', 'db.operation.name'],
    table: ['db.collection.name', 'db.table', 'db.mongodb.collection'],
    connection_string: ['db.connection_string'],
    rows_affected: ['db.rows_affected', 'db.result.rows_affected']
  },

  'cache-client': {
    command: ['db.operation', 'cache.operation', 'resource.name'],
    key: ['db.statement', 'cache.key', 'cache.item.key'],
    host: ['net.peer.name', 'server.address', 'out.host'],
    port: ['net.peer.port', 'server.port', 'out.port'],
    system: ['db.system', 'cache.system'],
    database: ['db.name', 'cache.namespace'],
    ttl: ['cache.ttl', 'cache.expiration'],
    hit: ['cache.hit', 'cache.result'],
    size: ['cache.item.size', 'cache.data.size']
  },

  'messaging-producer': {
    topic: ['messaging.destination.name', 'messaging.topic', 'resource.name'],
    system: ['messaging.system'],
    operation: ['messaging.operation'],
    message_id: ['messaging.message.id', 'messaging.message_id'],
    message_size: ['messaging.message.body.size', 'messaging.message.payload.size_bytes'],
    headers: ['messaging.header.*'],
    partition: ['messaging.kafka.partition', 'messaging.partition.id'],
    key: ['messaging.kafka.message.key', 'messaging.message.key'],
    broker: ['net.peer.name', 'server.address'],
    client_id: ['messaging.client_id', 'messaging.kafka.client_id']
  },

  'messaging-consumer': {
    topic: ['messaging.source.name', 'messaging.topic', 'resource.name'],
    system: ['messaging.system'],
    operation: ['messaging.operation'],
    message_id: ['messaging.message.id', 'messaging.message_id'],
    message_size: ['messaging.message.body.size', 'messaging.message.payload.size_bytes'],
    headers: ['messaging.header.*'],
    partition: ['messaging.kafka.partition', 'messaging.partition.id'],
    offset: ['messaging.kafka.message.offset', 'messaging.message.offset'],
    group_id: ['messaging.kafka.consumer.group', 'messaging.consumer.group.name'],
    broker: ['net.peer.name', 'server.address'],
    lag: ['messaging.kafka.consumer.lag', 'messaging.consumer.lag']
  }
}

/**
 * Data requirements specification with validation rules
 */
const DATA_REQUIREMENTS = {
  'http-client': {
    critical: {
      url: {
        description: 'Full URL or endpoint being requested',
        span_fields: SPAN_FIELD_MAPPINGS['http-client'].url,
        data_sources: [
          {
            type: 'argument',
            position: 0,
            format: 'string',
            description: 'First argument is often the URL string',
            examples: ['axios.get("https://api.example.com/users")', 'fetch("http://localhost:3000/health")']
          },
          {
            type: 'argument_property',
            position: 0,
            property: 'url',
            format: 'string',
            description: 'URL property in options object',
            examples: ['axios({ url: "https://api.example.com" })', 'request({ url: "http://localhost" })']
          },
          {
            type: 'argument_property',
            position: 0,
            property: 'uri',
            format: 'string',
            description: 'URI property in options object (alternative naming)',
            examples: ['request({ uri: "https://api.example.com" })']
          },
          {
            type: 'constructed_url',
            components: ['protocol', 'hostname', 'port', 'path'],
            description: 'URL constructed from separate components',
            examples: ['protocol://hostname:port/path from options.protocol + options.hostname + options.port + options.path']
          }
        ],
        validation: {
          required: true,
          type: 'string',
          format: 'url',
          min_length: 1
        },
        examples: ['https://api.example.com/users', 'http://localhost:3000/health']
      },
      method: {
        description: 'HTTP method used for the request',
        span_fields: SPAN_FIELD_MAPPINGS['http-client'].method,
        data_sources: [
          {
            type: 'function_name',
            format: 'string',
            description: 'HTTP method derived from function name',
            examples: ['axios.get() → GET', 'axios.post() → POST', 'client.put() → PUT']
          },
          {
            type: 'argument_property',
            position: 0,
            property: 'method',
            format: 'string',
            description: 'Method property in options object',
            examples: ['axios({ method: "POST" })', 'fetch(url, { method: "PUT" })']
          },
          {
            type: 'argument',
            position: 1,
            format: 'string',
            description: 'Method as second argument in some libraries',
            examples: ['request(url, "POST")', 'http.request(options, "GET")']
          },
          {
            type: 'default_value',
            value: 'GET',
            description: 'Default to GET when method not specified',
            examples: ['axios("http://example.com") → GET']
          }
        ],
        validation: {
          required: true,
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
          case_insensitive: true
        },
        examples: ['GET', 'POST', 'PUT']
      }
    },
    important: {
      status_code: {
        description: 'HTTP response status code',
        span_fields: SPAN_FIELD_MAPPINGS['http-client'].status_code,
        data_sources: [
          {
            type: 'response_property',
            property: 'status',
            format: 'integer',
            description: 'Status code from response object',
            examples: ['response.status', 'res.statusCode', 'result.status']
          },
          {
            type: 'response_property',
            property: 'statusCode',
            format: 'integer',
            description: 'Status code from Node.js response object',
            examples: ['response.statusCode', 'res.statusCode']
          },
          {
            type: 'callback_argument',
            position: 1,
            property: 'status',
            format: 'integer',
            description: 'Status from callback response argument',
            examples: ['callback(err, response) → response.status']
          }
        ],
        validation: {
          required: false,
          type: 'integer',
          min: 100,
          max: 599
        },
        examples: [200, 404, 500]
      },
      host: {
        description: 'Target server hostname or IP',
        span_fields: SPAN_FIELD_MAPPINGS['http-client'].host,
        data_sources: [
          {
            type: 'url_component',
            component: 'hostname',
            format: 'string',
            description: 'Hostname extracted from URL',
            examples: ['https://api.example.com/path → api.example.com']
          },
          {
            type: 'argument_property',
            position: 0,
            property: 'hostname',
            format: 'string',
            description: 'Hostname property in options object',
            examples: ['http.request({ hostname: "api.example.com" })']
          },
          {
            type: 'argument_property',
            position: 0,
            property: 'host',
            format: 'string',
            description: 'Host property in options object',
            examples: ['http.request({ host: "api.example.com:443" })']
          }
        ],
        validation: {
          required: false,
          type: 'string',
          min_length: 1
        },
        examples: ['api.example.com', '192.168.1.100', 'localhost']
      }
    },
    optional: {
      headers: {
        description: 'HTTP request headers',
        span_fields: SPAN_FIELD_MAPPINGS['http-client'].headers,
        validation: {
          required: false,
          type: 'object',
          sanitize: true // PII concerns
        },
        examples: [{ 'user-agent': 'MyApp/1.0' }, { authorization: '[REDACTED]' }]
      },
      timeout: {
        description: 'Request timeout in milliseconds',
        span_fields: SPAN_FIELD_MAPPINGS['http-client'].timeout,
        validation: {
          required: false,
          type: 'integer',
          min: 0
        },
        examples: [5000, 30000]
      }
    }
  },

  'database-client': {
    critical: {
      query: {
        description: 'Database query or operation statement',
        span_fields: SPAN_FIELD_MAPPINGS['database-client'].query,
        data_sources: [
          {
            type: 'argument',
            position: 0,
            format: 'string',
            description: 'SQL query as first argument',
            examples: ['connection.query("SELECT * FROM users")', 'db.execute("INSERT INTO ...")']
          },
          {
            type: 'argument_property',
            position: 0,
            property: 'text',
            format: 'string',
            description: 'Query text in options object',
            examples: ['client.query({ text: "SELECT * FROM users" })']
          },
          {
            type: 'argument_property',
            position: 0,
            property: 'sql',
            format: 'string',
            description: 'SQL property in options object',
            examples: ['connection.execute({ sql: "SELECT * FROM users" })']
          },
          {
            type: 'method_name',
            format: 'string',
            description: 'Operation derived from method name for NoSQL',
            examples: ['collection.find() → find', 'collection.insertOne() → insertOne']
          }
        ],
        validation: {
          required: true,
          type: 'string',
          min_length: 1,
          sanitize: true // Remove sensitive data
        },
        examples: ['SELECT * FROM users WHERE id = ?', 'db.users.find({active: true})']
      },
      system: {
        description: 'Database system type',
        span_fields: SPAN_FIELD_MAPPINGS['database-client'].system,
        data_sources: [
          {
            type: 'module_name',
            format: 'string',
            description: 'Database type from module name',
            examples: ['require("mysql2") → mysql', 'require("mongodb") → mongodb']
          },
          {
            type: 'connection_property',
            property: 'dialect',
            format: 'string',
            description: 'Database dialect from connection config',
            examples: ['sequelize.options.dialect → postgresql']
          },
          {
            type: 'class_name',
            format: 'string',
            description: 'Database type from client class name',
            examples: ['MySQLConnection → mysql', 'MongoClient → mongodb']
          }
        ],
        validation: {
          required: true,
          type: 'string',
          enum: ['mysql', 'postgresql', 'mongodb', 'redis', 'sqlite', 'oracle', 'mssql']
        },
        examples: ['mysql', 'postgresql', 'mongodb']
      }
    },
    important: {
      database: {
        description: 'Target database or schema name',
        span_fields: SPAN_FIELD_MAPPINGS['database-client'].database,
        validation: {
          required: false,
          type: 'string',
          min_length: 1
        },
        examples: ['users_db', 'inventory', 'analytics']
      },
      host: {
        description: 'Database server hostname or IP',
        span_fields: SPAN_FIELD_MAPPINGS['database-client'].host,
        validation: {
          required: false,
          type: 'string',
          min_length: 1
        },
        examples: ['db.example.com', '10.0.1.5', 'localhost']
      }
    },
    optional: {
      user: {
        description: 'Database username (sanitized)',
        span_fields: SPAN_FIELD_MAPPINGS['database-client'].user,
        validation: {
          required: false,
          type: 'string',
          sanitize: true
        },
        examples: ['app_user', 'readonly_user']
      },
      table: {
        description: 'Target table or collection name',
        span_fields: SPAN_FIELD_MAPPINGS['database-client'].table,
        validation: {
          required: false,
          type: 'string',
          min_length: 1
        },
        examples: ['users', 'orders', 'product_catalog']
      }
    }
  },

  'messaging-producer': {
    critical: {
      topic: {
        description: 'Message topic, queue, or exchange name',
        span_fields: SPAN_FIELD_MAPPINGS['messaging-producer'].topic,
        validation: {
          required: true,
          type: 'string',
          min_length: 1
        },
        examples: ['user-events', 'order.created', 'notifications']
      },
      system: {
        description: 'Messaging system type',
        span_fields: SPAN_FIELD_MAPPINGS['messaging-producer'].system,
        validation: {
          required: true,
          type: 'string',
          enum: ['kafka', 'rabbitmq', 'activemq', 'sqs', 'sns', 'pubsub']
        },
        examples: ['kafka', 'rabbitmq', 'sqs']
      }
    },
    important: {
      message_id: {
        description: 'Unique message identifier',
        span_fields: SPAN_FIELD_MAPPINGS['messaging-producer'].message_id,
        validation: {
          required: false,
          type: 'string',
          min_length: 1
        },
        examples: ['msg-12345', 'uuid-abcd-1234']
      },
      operation: {
        description: 'Messaging operation type',
        span_fields: SPAN_FIELD_MAPPINGS['messaging-producer'].operation,
        validation: {
          required: false,
          type: 'string',
          enum: ['publish', 'send', 'produce']
        },
        examples: ['publish', 'send']
      }
    },
    optional: {
      partition: {
        description: 'Message partition or routing key',
        span_fields: SPAN_FIELD_MAPPINGS['messaging-producer'].partition,
        validation: {
          required: false,
          type: ['string', 'integer']
        },
        examples: ['user-123', 0, 'routing.key']
      },
      message_size: {
        description: 'Message payload size in bytes',
        span_fields: SPAN_FIELD_MAPPINGS['messaging-producer'].message_size,
        validation: {
          required: false,
          type: 'integer',
          min: 0
        },
        examples: [1024, 512000]
      }
    }
  }
}

/**
 * Validation weights for different requirement levels
 */
const VALIDATION_WEIGHTS = {
  critical: 1.0,
  important: 0.7,
  optional: 0.3
}

/**
 * Validate a span against data requirements for a specific integration type
 * @param {Object} span - Span object with tags and metadata
 * @param {string} integrationType - Integration type (e.g., 'http-client')
 * @param {Object} options - Validation options
 * @returns {Object} Validation result
 */
function validateSpanData (span, integrationType, options = {}) {
  const requirements = DATA_REQUIREMENTS[integrationType]
  if (!requirements) {
    return {
      valid: false,
      score: 0,
      error: `Unknown integration type: ${integrationType}`,
      details: {}
    }
  }

  const result = {
    valid: true,
    score: 0,
    totalPossibleScore: 0,
    details: {},
    missing: [],
    invalid: [],
    present: []
  }

  // Validate each requirement level
  for (const [level, dataTypes] of Object.entries(requirements)) {
    const weight = VALIDATION_WEIGHTS[level]
    result.details[level] = {}

    for (const [dataType, spec] of Object.entries(dataTypes)) {
      result.totalPossibleScore += weight
      const validation = validateDataField(span, spec, options)

      result.details[level][dataType] = validation

      if (validation.present) {
        result.score += weight * (validation.valid ? 1.0 : 0.5) // Partial credit for present but invalid
        result.present.push(dataType)

        if (!validation.valid) {
          result.invalid.push({
            field: dataType,
            level,
            error: validation.error,
            value: validation.value
          })
        }
      } else {
        result.missing.push({
          field: dataType,
          level,
          required: spec.validation?.required || level === 'critical'
        })

        // Critical missing fields make the span invalid
        if (level === 'critical' && spec.validation?.required !== false) {
          result.valid = false
        }
      }
    }
  }

  result.completeness = result.totalPossibleScore > 0 ? result.score / result.totalPossibleScore : 0

  return result
}

/**
 * Validate a specific data field in a span
 * @param {Object} span - Span object
 * @param {Object} spec - Field specification
 * @param {Object} options - Validation options
 * @returns {Object} Field validation result
 */
function validateDataField (span, spec, options = {}) {
  const spanTags = span.meta || span.tags || {}
  const spanMetrics = span.metrics || {}

  // Check all possible span field locations
  let value = null
  let foundField = null

  for (const fieldName of spec.span_fields) {
    if (fieldName.endsWith('.*')) {
      // Handle wildcard fields (e.g., 'http.request.headers.*')
      const prefix = fieldName.slice(0, -2)
      const matchingFields = Object.keys(spanTags).filter(key => key.startsWith(prefix))
      if (matchingFields.length > 0) {
        value = matchingFields.reduce((acc, key) => {
          acc[key] = spanTags[key]
          return acc
        }, {})
        foundField = fieldName
        break
      }
    } else {
      // Check both meta and metrics
      if (spanTags[fieldName] !== undefined) {
        value = spanTags[fieldName]
        foundField = fieldName
        break
      }
      if (spanMetrics[fieldName] !== undefined) {
        value = spanMetrics[fieldName]
        foundField = fieldName
        break
      }
    }
  }

  const result = {
    present: value !== null && value !== undefined,
    value,
    field: foundField,
    valid: true,
    error: null
  }

  if (!result.present) {
    return result
  }

  // Validate the found value
  const validation = spec.validation || {}

  // Type validation
  if (validation.type) {
    const expectedTypes = Array.isArray(validation.type) ? validation.type : [validation.type]
    const actualType = Array.isArray(value) ? 'array' : typeof value

    if (!expectedTypes.includes(actualType)) {
      result.valid = false
      result.error = `Expected type ${expectedTypes.join(' or ')}, got ${actualType}`
      return result
    }
  }

  // String validations
  if (typeof value === 'string') {
    if (validation.min_length && value.length < validation.min_length) {
      result.valid = false
      result.error = `String too short: ${value.length} < ${validation.min_length}`
      return result
    }

    if (validation.enum) {
      const validValues = validation.enum
      const checkValue = validation.case_insensitive ? value.toLowerCase() : value
      const validSet = validation.case_insensitive
        ? validValues.map(v => v.toLowerCase())
        : validValues

      if (!validSet.includes(checkValue)) {
        result.valid = false
        result.error = `Invalid value: ${value}. Expected one of: ${validValues.join(', ')}`
        return result
      }
    }

    if (validation.format === 'url') {
      try {
        new URL(value)
      } catch (e) {
        result.valid = false
        result.error = `Invalid URL format: ${value}`
        return result
      }
    }
  }

  // Numeric validations
  if (typeof value === 'number') {
    if (validation.min !== undefined && value < validation.min) {
      result.valid = false
      result.error = `Value too small: ${value} < ${validation.min}`
      return result
    }

    if (validation.max !== undefined && value > validation.max) {
      result.valid = false
      result.error = `Value too large: ${value} > ${validation.max}`
      return result
    }
  }

  return result
}

/**
 * Get data requirements for a specific integration type
 * @param {string} integrationType - Integration type
 * @returns {Object|null} Requirements specification
 */
function getDataRequirements (integrationType) {
  return DATA_REQUIREMENTS[integrationType] || null
}

/**
 * Get all supported integration types
 * @returns {Array} Array of supported integration types
 */
function getSupportedIntegrationTypes () {
  return Object.keys(DATA_REQUIREMENTS)
}

/**
 * Get span field mappings for an integration type
 * @param {string} integrationType - Integration type
 * @returns {Object|null} Span field mappings
 */
function getSpanFieldMappings (integrationType) {
  return SPAN_FIELD_MAPPINGS[integrationType] || null
}

/**
 * Generate a validation report for multiple spans
 * @param {Array} spans - Array of span objects
 * @param {string} integrationType - Integration type
 * @param {Object} options - Validation options
 * @returns {Object} Aggregate validation report
 */
function validateSpansCollection (spans, integrationType, options = {}) {
  const results = spans.map(span => validateSpanData(span, integrationType, options))

  const report = {
    totalSpans: spans.length,
    validSpans: results.filter(r => r.valid).length,
    averageCompleteness: results.reduce((sum, r) => sum + r.completeness, 0) / results.length,
    commonMissingFields: {},
    commonInvalidFields: {},
    fieldPresenceStats: {}
  }

  // Aggregate missing and invalid fields
  results.forEach(result => {
    result.missing.forEach(missing => {
      const key = `${missing.level}.${missing.field}`
      report.commonMissingFields[key] = (report.commonMissingFields[key] || 0) + 1
    })

    result.invalid.forEach(invalid => {
      const key = `${invalid.level}.${invalid.field}`
      report.commonInvalidFields[key] = (report.commonInvalidFields[key] || 0) + 1
    })

    result.present.forEach(field => {
      report.fieldPresenceStats[field] = (report.fieldPresenceStats[field] || 0) + 1
    })
  })

  report.validationResults = results
  return report
}

module.exports = {
  DATA_REQUIREMENTS,
  SPAN_FIELD_MAPPINGS,
  VALIDATION_WEIGHTS,
  validateSpanData,
  getDataRequirements,
  getSupportedIntegrationTypes,
  getSpanFieldMappings,
  validateSpansCollection
}
