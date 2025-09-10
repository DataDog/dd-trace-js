# dd-apm-test-runner

A test runner tool for dd-trace integrations that intelligently handles service dependencies and provides structured output for LLM consumption.

## Features

- **Intelligent Service Detection**: Automatically detects if a plugin needs Docker services (Redis, Postgres, MongoDB, etc.)
- **Docker Service Management**: Starts and stops required services automatically
- **Structured Output**: Returns detailed, parseable results perfect for LLM analysis
- **Test Result Parsing**: Extracts test counts, failures, and summaries from various test frameworks
- **Timeout Handling**: Configurable timeouts with proper cleanup
- **Verbose Logging**: Detailed output for debugging

## Usage

### Basic Usage

```bash
# Test a simple plugin (no service dependencies)
node bin/dd-apm-test-runner.js test axios

# Test with explicit service dependency
node bin/dd-apm-test-runner.js test redis --service redis

# Test with verbose output
node bin/dd-apm-test-runner.js test postgres --verbose
```

### Options

- `--service <service>`: Explicitly specify Docker service to start
- `--no-cleanup`: Skip Docker cleanup after tests (useful for debugging)
- `--timeout <seconds>`: Test timeout in seconds (default: 300)
- `--verbose`: Show detailed output during execution

### Supported Services

The tool automatically detects service needs based on plugin names:

- **redis** → `redis` service
- **postgres/postgresql** → `postgres` service  
- **mongodb/mongo** → `mongo` service
- **mysql** → `mysql` service
- **elasticsearch** → `elasticsearch` service
- **rabbitmq** → `rabbitmq` service
- **kafka** → `kafka` service
- **cassandra** → `cassandra` service
- **memcached** → `memcached` service

## Output Format

The tool returns a structured JSON result perfect for LLM consumption:

```javascript
{
  pluginId: 'axios',
  service: null,
  success: true,
  steps: [
    {
      name: 'run-tests',
      command: 'PLUGINS=axios yarn test:plugins:ci',
      success: true,
      output: '...',
      duration: 15000,
      testResults: {
        total: 25,
        passed: 25,
        failed: 0,
        skipped: 0,
        failures: [],
        summary: 'Tests: 25 passed, 25 total'
      }
    }
  ],
  output: 'full test output...',
  duration: 15000,
  testResults: { /* parsed results */ }
}
```

## Integration with LLM Workflows

This tool is designed to be used by LLMs to:

1. **Validate Generated Code**: Test newly scaffolded integrations
2. **Debug Test Failures**: Get structured failure information for fixes
3. **Iterate on Solutions**: Run tests repeatedly during development
4. **Handle Dependencies**: Automatically manage required services

### Example LLM Usage

```javascript
// LLM can call this to test a generated integration
const result = await testRunner.runTests()

if (!result.success) {
  // LLM can analyze the structured failure data
  console.log(`Tests failed: ${result.error}`)
  console.log(`Failed tests: ${result.testResults.failures.join(', ')}`)
  
  // LLM can then modify code and re-run tests
}
```

## Process Flow

1. **Service Detection**: Analyzes plugin name and docker-compose.yml to determine service needs
2. **Service Startup**: If needed, runs `docker-compose up -d <service>` and waits for readiness
3. **Test Execution**: Runs `PLUGINS=<plugin-id> yarn test:plugins:ci` with proper environment
4. **Result Parsing**: Extracts test counts, failures, and summaries from output
5. **Cleanup**: Optionally runs `docker-compose down` to clean up services

## Error Handling

- **Service Startup Failures**: Detailed error messages and service logs
- **Test Timeouts**: Graceful termination with partial results
- **Parse Errors**: Fallback to raw output if parsing fails
- **Cleanup Failures**: Non-blocking cleanup errors with warnings

## Dependencies

- **Node.js**: >= 14.0.0
- **Docker & Docker Compose**: For service dependencies
- **Yarn**: For running dd-trace tests
- **dd-trace workspace**: Must be run from dd-trace-js root directory
