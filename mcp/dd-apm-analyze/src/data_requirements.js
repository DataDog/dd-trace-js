'use strict'

/**
 * Data Requirements Schema for APM Integration Scoring
 *
 * This module defines the specific data that each plugin type needs to extract
 * from function arguments to create meaningful spans. Used to score instrumentation
 * targets based on their ability to provide required span data.
 */

const DATA_REQUIREMENTS = {
  // HTTP Client (e.g., axios, got, node-fetch)
  'http-client': {
    critical: {
      url: {
        description: 'Full URL or components (protocol, host, path) for the HTTP request',
        patterns: [
          'url', 'uri', 'href', 'endpoint', 'target',
          'protocol', 'hostname', 'host', 'path', 'pathname',
          'options.url', 'options.uri', 'options.href',
          'config.url', 'config.baseURL', 'config.uri'
        ],
        extractors: [
          'args[0]', // First argument often URL string
          'args[0].url', 'args[0].uri', 'args[0].href',
          'options.url', 'options.uri', 'options.href',
          'config.url', 'config.baseURL'
        ]
      },
      method: {
        description: 'HTTP method (GET, POST, PUT, DELETE, etc.)',
        patterns: [
          'method', 'verb', 'type',
          'options.method', 'config.method'
        ],
        extractors: [
          'args[0].method', 'options.method', 'config.method',
          'method' // For method-specific functions like .get(), .post()
        ]
      }
    },
    important: {
      headers: {
        description: 'Request headers for tracing injection and monitoring',
        patterns: [
          'headers', 'requestHeaders',
          'options.headers', 'config.headers'
        ],
        extractors: [
          'args[0].headers', 'args[1].headers',
          'options.headers', 'config.headers'
        ]
      },
      timeout: {
        description: 'Request timeout for performance monitoring',
        patterns: [
          'timeout', 'requestTimeout',
          'options.timeout', 'config.timeout'
        ],
        extractors: [
          'args[0].timeout', 'options.timeout', 'config.timeout'
        ]
      }
    },
    optional: {
      body: {
        description: 'Request body/data for debugging (sanitized)',
        patterns: [
          'body', 'data', 'payload',
          'options.body', 'options.data', 'config.data'
        ],
        extractors: [
          'args[0].body', 'args[0].data', 'args[1]',
          'options.body', 'options.data', 'config.data'
        ]
      },
      agent: {
        description: 'HTTP agent configuration for connection pooling insights',
        patterns: [
          'agent', 'httpAgent', 'httpsAgent',
          'options.agent', 'config.agent'
        ],
        extractors: [
          'args[0].agent', 'options.agent', 'config.agent'
        ]
      }
    }
  },

  // HTTP Server (e.g., express, koa, fastify)
  'http-server': {
    critical: {
      request: {
        description: 'HTTP request object with URL, method, headers',
        patterns: [
          'req', 'request', 'ctx.request',
          'args[0]', 'message.req'
        ],
        extractors: [
          'req', 'request', 'ctx.req', 'ctx.request',
          'args[0]', 'args[0].req', 'message.req'
        ]
      },
      response: {
        description: 'HTTP response object for status code and headers',
        patterns: [
          'res', 'response', 'ctx.response',
          'args[1]', 'message.res'
        ],
        extractors: [
          'res', 'response', 'ctx.res', 'ctx.response',
          'args[1]', 'args[1].res', 'message.res'
        ]
      }
    },
    important: {
      route: {
        description: 'Route pattern/path for resource naming',
        patterns: [
          'route', 'path', 'pattern', 'url',
          'req.route', 'req.path', 'req.url'
        ],
        extractors: [
          'route', 'path', 'pattern',
          'req.route', 'req.path', 'req.url',
          'args[0]' // For route definition functions
        ]
      },
      middleware: {
        description: 'Middleware function or chain for tracing context',
        patterns: [
          'middleware', 'handler', 'callback', 'next',
          'args[1]', 'args[2]'
        ],
        extractors: [
          'middleware', 'handler', 'callback',
          'args[1]', 'args[2]', 'args[args.length-1]'
        ]
      }
    }
  },

  // Database Client (e.g., mysql, postgres, mongodb)
  'database-client': {
    critical: {
      query: {
        description: 'SQL query or database operation for resource naming',
        patterns: [
          'sql', 'query', 'statement', 'command',
          'text', 'operation', 'method'
        ],
        extractors: [
          'args[0]', 'args[0].sql', 'args[0].text',
          'sql', 'query', 'statement', 'command'
        ]
      },
      connection: {
        description: 'Database connection info (host, port, database name)',
        patterns: [
          'connection', 'config', 'options', 'connectionString',
          'host', 'port', 'database', 'db'
        ],
        extractors: [
          'connection', 'config', 'options',
          'this.config', 'this.connection', 'this.options'
        ]
      }
    },
    important: {
      parameters: {
        description: 'Query parameters/values for debugging (sanitized)',
        patterns: [
          'params', 'parameters', 'values', 'bindings',
          'args[1]', 'queryParams'
        ],
        extractors: [
          'args[1]', 'params', 'parameters', 'values'
        ]
      },
      database: {
        description: 'Target database/schema name',
        patterns: [
          'database', 'db', 'schema', 'keyspace',
          'config.database', 'options.database'
        ],
        extractors: [
          'database', 'db', 'schema',
          'config.database', 'options.database'
        ]
      }
    }
  },

  // Cache Client (e.g., redis, memcached)
  'cache-client': {
    critical: {
      command: {
        description: 'Cache command/operation (GET, SET, DEL, etc.)',
        patterns: [
          'command', 'operation', 'method', 'cmd'
        ],
        extractors: [
          'command', 'args[0]', // Often first arg is command
          'this.command', 'operation'
        ]
      },
      key: {
        description: 'Cache key being accessed',
        patterns: [
          'key', 'keys', 'cacheKey',
          'args[0]', 'args[1]' // Depending on command structure
        ],
        extractors: [
          'key', 'args[0]', 'args[1]',
          'cacheKey', 'keys'
        ]
      }
    },
    important: {
      value: {
        description: 'Cache value for SET operations (sanitized)',
        patterns: [
          'value', 'data', 'payload',
          'args[1]', 'args[2]'
        ],
        extractors: [
          'value', 'args[1]', 'args[2]', 'data'
        ]
      },
      ttl: {
        description: 'Time-to-live for cache entries',
        patterns: [
          'ttl', 'expire', 'expiration', 'timeout',
          'args[2]', 'options.ttl'
        ],
        extractors: [
          'ttl', 'expire', 'expiration',
          'args[2]', 'options.ttl'
        ]
      }
    }
  },

  // Messaging Producer (e.g., kafka producer, rabbitmq publisher)
  'messaging-producer': {
    critical: {
      topic: {
        description: 'Topic/queue/exchange name for message routing',
        patterns: [
          'topic', 'queue', 'exchange', 'destination',
          'routingKey', 'subject'
        ],
        extractors: [
          'topic', 'queue', 'exchange', 'destination',
          'args[0]', 'options.topic', 'fields.exchange'
        ]
      },
      message: {
        description: 'Message payload/content',
        patterns: [
          'message', 'payload', 'data', 'content',
          'body', 'value'
        ],
        extractors: [
          'message', 'payload', 'data', 'content',
          'args[1]', 'args[0].message'
        ]
      }
    },
    important: {
      headers: {
        description: 'Message headers for tracing propagation',
        patterns: [
          'headers', 'properties', 'metadata',
          'message.headers', 'options.headers'
        ],
        extractors: [
          'headers', 'properties', 'metadata',
          'message.headers', 'args[0].headers'
        ]
      },
      partition: {
        description: 'Partition/routing information',
        patterns: [
          'partition', 'partitionKey', 'routingKey',
          'options.partition'
        ],
        extractors: [
          'partition', 'partitionKey', 'routingKey',
          'options.partition', 'fields.routingKey'
        ]
      }
    }
  },

  // Messaging Consumer (e.g., kafka consumer, rabbitmq subscriber)
  'messaging-consumer': {
    critical: {
      topic: {
        description: 'Topic/queue being consumed from',
        patterns: [
          'topic', 'queue', 'subscription',
          'args[0]', 'options.topic'
        ],
        extractors: [
          'topic', 'queue', 'subscription',
          'args[0]', 'options.topic'
        ]
      },
      message: {
        description: 'Received message with content and metadata',
        patterns: [
          'message', 'record', 'event', 'data',
          'args[0]', 'args[1]'
        ],
        extractors: [
          'message', 'record', 'event',
          'args[0]', 'args[1]', 'ctx.message'
        ]
      }
    },
    important: {
      groupId: {
        description: 'Consumer group identifier',
        patterns: [
          'groupId', 'consumerGroup', 'group',
          'options.groupId'
        ],
        extractors: [
          'groupId', 'consumerGroup', 'group',
          'options.groupId', 'config.groupId'
        ]
      },
      offset: {
        description: 'Message offset for ordering and replay',
        patterns: [
          'offset', 'position', 'sequence',
          'message.offset'
        ],
        extractors: [
          'offset', 'position', 'sequence',
          'message.offset', 'record.offset'
        ]
      }
    }
  }
}

/**
 * Scoring weights for data requirement categories
 */
const SCORING_WEIGHTS = {
  critical: 1.0, // Must have this data for meaningful spans
  important: 0.7, // Significantly improves span quality
  optional: 0.3 // Nice to have, minimal impact
}

/**
 * Score a function based on its ability to provide required data
 * @param {Object} target - Instrumentation target from analyzer
 * @param {string} category - Integration category (e.g., 'http')
 * @param {string} subcategory - Integration subcategory (e.g., 'client')
 * @returns {Object} Scoring result with breakdown
 */
function scoreDataAvailability (target, category, subcategory) {
  const requirementKey = `${category}-${subcategory}`
  const requirements = DATA_REQUIREMENTS[requirementKey]

  if (!requirements) {
    return {
      score: 0.5, // Neutral score for unknown types
      breakdown: {},
      reasoning: `No data requirements defined for ${requirementKey}`
    }
  }

  const breakdown = {}
  let totalScore = 0
  let maxPossibleScore = 0

  // Analyze each requirement category
  for (const [priority, dataTypes] of Object.entries(requirements)) {
    const weight = SCORING_WEIGHTS[priority]
    breakdown[priority] = {}

    for (const [dataType, spec] of Object.entries(dataTypes)) {
      maxPossibleScore += weight
      const availability = analyzeDataAvailability(target, spec)
      const score = availability.score * weight
      totalScore += score

      breakdown[priority][dataType] = {
        available: availability.available,
        confidence: availability.confidence,
        patterns: availability.matchedPatterns,
        score,
        weight
      }
    }
  }

  const finalScore = maxPossibleScore > 0 ? totalScore / maxPossibleScore : 0

  return {
    score: Math.min(1.0, Math.max(0.0, finalScore)),
    breakdown,
    reasoning: generateScoreReasoning(breakdown, finalScore),
    dataAvailability: {
      critical: getCategoryScore(breakdown, 'critical'),
      important: getCategoryScore(breakdown, 'important'),
      optional: getCategoryScore(breakdown, 'optional')
    }
  }
}

/**
 * Analyze if a target can provide specific data based on patterns
 * @param {Object} target - Instrumentation target
 * @param {Object} spec - Data requirement specification
 * @returns {Object} Availability analysis
 */
function analyzeDataAvailability (target, spec) {
  const functionName = target.function_name || ''
  const exportPath = target.export_path || ''
  const module = target.module || ''

  // Check if function name indicates data availability
  const nameMatches = spec.patterns.some(pattern =>
    functionName.toLowerCase().includes(pattern.toLowerCase()) ||
    exportPath.toLowerCase().includes(pattern.toLowerCase())
  )

  // Estimate based on function context and common patterns
  let confidence = 0
  const matchedPatterns = []

  if (nameMatches) {
    confidence += 0.4
    matchedPatterns.push(...spec.patterns.filter(pattern =>
      functionName.toLowerCase().includes(pattern.toLowerCase()) ||
      exportPath.toLowerCase().includes(pattern.toLowerCase())
    ))
  }

  // Boost confidence for known high-value functions
  const highValueFunctions = [
    'request', 'get', 'post', 'put', 'delete', 'patch',
    'query', 'execute', 'find', 'insert', 'update',
    'publish', 'send', 'consume', 'subscribe',
    'set', 'get', 'del', 'exists'
  ]

  if (highValueFunctions.some(fn => functionName.toLowerCase().includes(fn))) {
    confidence += 0.3
  }

  // Consider function signature and common argument patterns
  if (spec.extractors.some(extractor => extractor.includes('args[0]'))) {
    confidence += 0.2 // First argument often contains key data
  }

  return {
    available: confidence > 0.3,
    confidence: Math.min(1.0, confidence),
    score: Math.min(1.0, confidence),
    matchedPatterns
  }
}

/**
 * Generate human-readable reasoning for the score
 */
function generateScoreReasoning (breakdown, score) {
  const reasons = []

  for (const [priority, dataTypes] of Object.entries(breakdown)) {
    const available = Object.values(dataTypes).filter(d => d.available).length
    const total = Object.keys(dataTypes).length

    if (available > 0) {
      reasons.push(`${available}/${total} ${priority} data types available`)
    }
  }

  if (reasons.length === 0) {
    return 'Limited data availability detected for meaningful spans'
  }

  return reasons.join(', ') + ` (overall score: ${(score * 100).toFixed(0)}%)`
}

/**
 * Get average score for a category
 */
function getCategoryScore (breakdown, category) {
  if (!breakdown[category]) return 0

  const scores = Object.values(breakdown[category]).map(d => d.score)
  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
}

/**
 * Get data requirements for a specific integration type
 * @param {string} category - Integration category
 * @param {string} subcategory - Integration subcategory
 * @returns {Object} Data requirements specification
 */
function getDataRequirements (category, subcategory) {
  const key = `${category}-${subcategory}`
  return DATA_REQUIREMENTS[key] || null
}

/**
 * List all supported integration types
 * @returns {Array} Array of supported category-subcategory combinations
 */
function getSupportedTypes () {
  return Object.keys(DATA_REQUIREMENTS)
}

module.exports = {
  DATA_REQUIREMENTS,
  SCORING_WEIGHTS,
  scoreDataAvailability,
  getDataRequirements,
  getSupportedTypes,
  analyzeDataAvailability
}
