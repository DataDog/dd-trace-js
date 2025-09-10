# Data Requirements System for APM Integration Scoring

## Overview

The Data Requirements System is a sophisticated scoring mechanism that evaluates instrumentation targets based on their ability to provide meaningful span data. Instead of just analyzing function names and patterns, this system considers what data each function can realistically extract to create high-quality distributed tracing spans.

## Problem Statement

Previously, the analyzer would score functions purely based on naming patterns and frequency analysis. This led to instrumenting functions that might be called frequently but provide no useful context data for spans. For example:

- **Bad Target**: A utility function `isString()` might score highly due to frequency, but provides no HTTP request data
- **Good Target**: An HTTP request function `axios.get(url, config)` provides URL, method, headers, and other critical span data

## Solution Architecture

### 1. Data Requirements Schema

Each integration type (e.g., `http-client`, `database-client`) has a defined schema of required data:

```javascript
'http-client': {
  critical: {
    url: { /* URL/endpoint information */ },
    method: { /* HTTP method (GET, POST, etc.) */ }
  },
  important: {
    headers: { /* Request headers */ },
    timeout: { /* Request timeout */ }
  },
  optional: {
    body: { /* Request payload */ },
    agent: { /* HTTP agent config */ }
  }
}
```

### 2. Pattern Matching

For each data requirement, the system defines:
- **Patterns**: Common argument/property names that indicate data availability
- **Extractors**: Specific paths to access the data (e.g., `args[0].url`, `options.method`)

### 3. Scoring Algorithm

The system combines traditional confidence scores with data availability scores:

```
Final Score = (Original Score × 0.6) + (Data Score × 0.4)
```

This balanced approach ensures functions with high data availability get prioritized while maintaining consideration for traditional indicators.

## Supported Integration Types

### HTTP Client (`http-client`)
**Examples**: axios, got, node-fetch, undici

**Critical Data**:
- `url`: Full URL or components (protocol, host, path)
- `method`: HTTP method (GET, POST, PUT, DELETE)

**Important Data**:
- `headers`: Request headers for tracing injection
- `timeout`: Request timeout for performance monitoring

**Optional Data**:
- `body`: Request payload (sanitized for debugging)
- `agent`: HTTP agent configuration

### HTTP Server (`http-server`) 
**Examples**: express, koa, fastify, hapi

**Critical Data**:
- `request`: HTTP request object with URL, method, headers
- `response`: HTTP response object for status codes

**Important Data**:
- `route`: Route pattern/path for resource naming
- `middleware`: Middleware functions for context tracing

### Database Client (`database-client`)
**Examples**: mysql, postgres, mongodb, sequelize

**Critical Data**:
- `query`: SQL query or database operation
- `connection`: Database connection info (host, port, database)

**Important Data**:
- `parameters`: Query parameters/values (sanitized)
- `database`: Target database/schema name

### Cache Client (`cache-client`)
**Examples**: redis, memcached, ioredis

**Critical Data**:
- `command`: Cache operation (GET, SET, DEL, etc.)
- `key`: Cache key being accessed

**Important Data**:
- `value`: Cache value for SET operations (sanitized)
- `ttl`: Time-to-live for cache entries

### Messaging Producer (`messaging-producer`)
**Examples**: kafka producer, rabbitmq publisher

**Critical Data**:
- `topic`: Topic/queue/exchange name
- `message`: Message payload/content

**Important Data**:
- `headers`: Message headers for tracing propagation
- `partition`: Partition/routing information

### Messaging Consumer (`messaging-consumer`)
**Examples**: kafka consumer, rabbitmq subscriber

**Critical Data**:
- `topic`: Topic/queue being consumed from
- `message`: Received message with metadata

**Important Data**:
- `groupId`: Consumer group identifier
- `offset`: Message offset for ordering

## Implementation Details

### Data Availability Analysis

The system analyzes each instrumentation target using multiple signals:

1. **Function Name Analysis**: Does the function name contain data-related keywords?
2. **Export Path Analysis**: Does the module path suggest data availability?
3. **High-Value Function Detection**: Is this a known high-value function type?
4. **Argument Pattern Matching**: Do common argument patterns suggest data access?

### Scoring Weights

- **Critical Data**: 1.0 weight - Must have for meaningful spans
- **Important Data**: 0.7 weight - Significantly improves span quality  
- **Optional Data**: 0.3 weight - Nice to have, minimal impact

### Example Scoring

For an `axios.get()` function:

```javascript
{
  "function_name": "get",
  "confidence_score": 0.88,  // Combined score
  "data_score": 0.8,         // Data availability score
  "data_availability": {
    "critical": 0.9,         // High URL/method availability
    "important": 0.8,        // Good headers/timeout access
    "optional": 0.6          // Some body/agent access
  },
  "data_reasoning": "2/2 critical data types available, 2/2 important data types available (overall score: 80%)",
  "original_score": 0.95     // Pre-data-scoring confidence
}
```

## Configuration

### CLI Options

```bash
# Enable data requirements scoring (default: true)
dd-apm-analyze analyze axios --data-scoring

# Disable data requirements scoring
dd-apm-analyze analyze axios --no-data-scoring
```

### Environment Variables

No additional environment variables required. The system uses the same LLM services as other analyzer features.

## Benefits

### 1. Higher Quality Instrumentation
Functions are selected based on their ability to provide meaningful span data, not just naming patterns.

### 2. Reduced Noise
Low-value utility functions are deprioritized, reducing instrumentation overhead.

### 3. Category-Specific Intelligence
Each integration type has tailored data requirements matching real-world plugin needs.

### 4. Balanced Scoring
Combines traditional confidence signals with data availability for robust target selection.

### 5. Extensible Architecture
New integration types and data requirements can be easily added to the schema.

## Real-World Impact

### Before Data Requirements System
```javascript
// High-scoring but low-value targets
{ "function_name": "toString", "confidence_score": 0.85 }
{ "function_name": "isString", "confidence_score": 0.82 }
{ "function_name": "bind", "confidence_score": 0.78 }
```

### After Data Requirements System  
```javascript
// High-scoring, high-value targets
{ "function_name": "get", "confidence_score": 0.88, "data_score": 0.8 }
{ "function_name": "request", "confidence_score": 0.85, "data_score": 0.9 }
{ "function_name": "post", "confidence_score": 0.82, "data_score": 0.85 }
```

## Future Enhancements

### 1. Dynamic Pattern Learning
Machine learning models could learn new data patterns from successful integrations.

### 2. Runtime Validation
Validate that instrumented functions actually provide expected data during testing.

### 3. Custom Data Requirements
Allow users to define custom data requirements for specialized integration types.

### 4. Performance Impact Analysis
Consider the performance cost of data extraction when scoring targets.

## Integration with Existing Tools

### Analyzer Integration
- Seamlessly integrated into the existing analysis pipeline
- Respects all existing CLI options and configuration
- Maintains backward compatibility

### Scaffolder Integration
- Generated instrumentation code considers data requirements
- Plugin templates optimized for high-data-availability targets
- Test generation includes data validation

### Test Runner Integration
- Test suites validate that instrumented functions provide expected data
- Performance tests ensure data extraction doesn't impact application performance

## Troubleshooting

### Low Data Scores
If functions are receiving low data scores:

1. **Check Integration Type**: Ensure the detected category/subcategory is correct
2. **Review Function Names**: Functions with generic names may score lower
3. **Examine Arguments**: Functions with complex argument structures may need manual review
4. **Consider Custom Patterns**: Add custom patterns to the data requirements schema

### Missing Data Types
If critical data types aren't detected:

1. **Update Patterns**: Add new patterns to the data requirements schema
2. **Review Extractors**: Ensure extractor paths match the library's API
3. **Test with Real Code**: Validate patterns against actual library usage

### Performance Issues
If data scoring impacts analysis performance:

1. **Disable for Large Libraries**: Use `--no-data-scoring` for very large packages
2. **Limit Target Count**: Use `--maxTotal` to reduce the number of targets analyzed
3. **Focus on High-Confidence Targets**: Use `--minScore` to filter low-confidence targets

This data requirements system represents a significant advancement in APM integration quality, ensuring that instrumentation efforts focus on functions that will provide the most valuable observability data.
