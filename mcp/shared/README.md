# APM Data Requirements - Multi-Use System

This directory contains a generic, reusable APM data requirements specification that can be used across multiple systems and tools.

## Overview

The APM Data Requirements system provides a standardized way to:

1. **Define** what data each integration type should capture
2. **Score** instrumentation targets based on data availability (analyzer)
3. **Validate** spans against data completeness requirements (test agents)
4. **Generate** appropriate instrumentation code (scaffolding tools)

## Architecture

### Core Components

- **`apm-data-requirements.js`**: Generic data requirements specification with validation rules
- **`apm-test-validator.js`**: Validation utilities for test agents and CI/CD
- **`examples/analyzer-integration.js`**: Integration example for code analyzers
- **`examples/test-agent-integration.js`**: Integration example for APM test agents

### Multi-Use Design

The system is designed to be used by:

- **Code Analyzers**: Score instrumentation targets based on data availability
- **APM Test Agents**: Validate spans for data completeness and quality
- **Scaffolding Tools**: Generate instrumentation with appropriate data capture
- **CI/CD Systems**: Automated quality checks for integration spans
- **Documentation Tools**: Generate integration guides with data requirements

## Data Requirements Structure

Each integration type has three levels of data requirements with detailed extraction guidance:

### Critical Data (Weight: 1.0)
Must-have information for meaningful spans. Missing critical data makes spans largely useless for observability.

### Important Data (Weight: 0.7)
Significantly improves span quality and debugging capabilities. Should be captured when available.

### Optional Data (Weight: 0.3)
Nice-to-have information that provides additional context but isn't essential for basic observability.

### Data Source Information

Each data requirement includes detailed extraction guidance:

- **Data Source Types**: `argument`, `argument_property`, `function_name`, `response_property`, `url_component`, `module_name`, `class_name`, `default_value`
- **Extraction Instructions**: Step-by-step guidance for accessing the data
- **Code Examples**: Real-world examples showing how to extract the data
- **Complexity Levels**: `simple`, `moderate`, `complex` based on extraction difficulty
- **Alternative Methods**: Multiple ways to access the same data for robustness

## Supported Integration Types

- **`http-client`**: axios, got, node-fetch, undici
- **`http-server`**: express, koa, fastify, hapi
- **`database-client`**: mysql, postgres, mongodb, redis
- **`cache-client`**: redis, memcached, ioredis
- **`messaging-producer`**: kafka producer, rabbitmq publisher
- **`messaging-consumer`**: kafka consumer, rabbitmq subscriber

## Usage Examples

### 1. Code Analyzer (Scoring Instrumentation Targets)

```javascript
const { scoreDataAvailability } = require('./examples/analyzer-integration')

// Score a function based on its ability to provide span data
const target = {
  function_name: 'get',
  export_path: 'default',
  module: 'axios'
}

const result = scoreDataAvailability(target, 'http', 'client')
console.log(`Data score: ${result.score}`) // 0.0 - 1.0
console.log(`Expected span fields:`, result.expectedSpanFields)

// Access detailed extraction guidance
result.breakdown.critical.url.extractionGuide
// Returns: {
//   primary: "Extract from argument 0 (string)",
//   alternatives: [
//     { method: "Extract from args[0].url (string)", examples: [...] },
//     { method: "Extract from args[0].uri (string)", examples: [...] }
//   ],
//   complexity: "simple"
// }
```

### 2. APM Test Agent (Validating Spans)

```javascript
const { createTestValidator } = require('./apm-test-validator')

const validator = createTestValidator()

// Validate a single span
const span = {
  meta: {
    'http.url': 'https://api.example.com/users',
    'http.method': 'GET',
    'http.status_code': '200'
  }
}

const result = validator.validateSpan(span, 'http-client')
console.log(`Valid: ${result.valid}`)
console.log(`Completeness: ${(result.completeness * 100).toFixed(1)}%`)

// Validate multiple spans from a test run
const spans = [span1, span2, span3]
const report = validator.validateTestRun(spans, 'http-client')
console.log(`Success rate: ${report.summary.successRate}`)
```

### 3. CI/CD Integration

```javascript
const { APMTestAgent } = require('./examples/test-agent-integration')

const testAgent = new APMTestAgent({ strict: true })

// Collect spans during test execution
testAgent.receiveSpan(span1)
testAgent.receiveSpan(span2)

// Generate CI report
const report = testAgent.generateCIReport()
console.log(`Overall success rate: ${report.overall.successRate}`)

// Assert quality for specific integration
try {
  testAgent.assertIntegrationQuality('http-client')
  console.log('✅ HTTP client integration meets quality standards')
} catch (error) {
  console.log('❌ Integration quality check failed:', error.message)
  process.exit(1)
}
```

## Span Field Mappings

The system maps conceptual data requirements to actual span tag names:

```javascript
{
  'http-client': {
    url: ['http.url', 'http.target', 'url.full'],
    method: ['http.method', 'http.request.method'],
    status_code: ['http.status_code', 'http.response.status_code'],
    // ... more mappings
  }
}
```

This allows the same requirements to work with different span formats and naming conventions.

## Validation Rules

Each data requirement includes validation rules:

```javascript
{
  url: {
    description: 'Full URL or endpoint being requested',
    span_fields: ['http.url', 'http.target'],
    validation: {
      required: true,
      type: 'string',
      format: 'url',
      min_length: 1
    },
    examples: ['https://api.example.com/users']
  }
}
```

## Extending the System

### Adding New Integration Types

1. Add the integration type to `DATA_REQUIREMENTS` in `apm-data-requirements.js`
2. Define span field mappings in `SPAN_FIELD_MAPPINGS`
3. Add detection logic in test agent examples if needed

### Adding New Data Requirements

1. Add the requirement to the appropriate integration type
2. Include span field mappings
3. Define validation rules
4. Provide examples

### Custom Validation Options

The validation system supports custom options:

```javascript
const validator = createTestValidator({
  strictMode: true,        // Fail on any missing critical data
  minCompleteness: 0.9,    // Minimum completeness score (0.0-1.0)
  logResults: false,       // Disable logging for CI environments
  sanitizeData: true       // Apply data sanitization rules
})
```

## Integration with Existing Tools

### Analyzer Integration

The analyzer uses the generic data requirements to:
- Score instrumentation targets based on data availability
- Generate expected span field information for scaffolding
- Provide consistent scoring across different integration types

### Scaffolder Integration

The scaffolder can use the requirements to:
- Generate instrumentation code that captures required data
- Create appropriate plugin base classes
- Generate test examples with expected span data

### Test Runner Integration

The test runner can use validation to:
- Verify generated integrations produce quality spans
- Provide feedback on data completeness
- Generate quality reports for CI/CD

## Best Practices

### For Analyzer Usage
- Use the generic scoring system for consistency with test validation
- Include expected span fields in analysis reports
- Consider data requirements when selecting instrumentation targets

### For Test Agent Usage
- Use strict validation in CI/CD environments
- Log detailed results during development
- Generate comprehensive reports for debugging

### For CI/CD Integration
- Set appropriate completeness thresholds for your quality standards
- Use strict mode for production deployments
- Monitor trends in data completeness over time

## Performance Considerations

- Validation is designed to be fast and suitable for real-time use
- Span field lookups use efficient mapping strategies
- Validation rules are applied only when fields are present
- Memory usage is minimal for typical span volumes

## Future Enhancements

- **Machine Learning**: Learn data patterns from successful integrations
- **Custom Requirements**: Allow user-defined data requirements
- **Performance Metrics**: Track data extraction performance impact
- **Schema Evolution**: Support versioned data requirements
- **Integration Templates**: Generate integration code from requirements

This multi-use system ensures consistency across all APM tooling while providing flexibility for different use cases and environments.
