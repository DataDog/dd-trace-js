# APM Integration Scaffolding Tools - MCP Documentation

This document provides comprehensive documentation for the APM (Application Performance Monitoring) integration scaffolding tools following the Model Context Protocol (MCP) standard. These tools enable automated analysis and scaffolding of Node.js library integrations for distributed tracing systems.

## Table of Contents

1. [dd-apm-analyze](#dd-apm-analyze) - Code Analysis Tool
2. [dd-apm-scaffold](#dd-apm-scaffold) - Project Scaffolding Tool  
3. [dd-apm-test-runner](#dd-apm-test-runner) - Test Execution Tool
4. [Integration Examples](#integration-examples)
5. [MCP Tool Specifications](#mcp-tool-specifications)

---

## dd-apm-analyze

**Purpose**: Analyzes Node.js packages to identify instrumentation targets and generate comprehensive analysis reports for APM integration development.

### Description

The `dd-apm-analyze` tool performs deep static analysis of npm packages to:
- Identify high-value instrumentation targets (functions, methods, classes)
- Detect package categories and subcategories (http-client, http-server, database-client, etc.)
- Generate test examples and documentation signals
- Provide LLM-enhanced analysis with code verification
- Support multi-version analysis for API difference detection
- Generate structured reports for downstream scaffolding tools

### Commands

#### `analyze <pkg>`

Analyzes a package to find instrumentation targets.

**Usage:**
```bash
dd-apm-analyze analyze <pkg> [options]
```

**Arguments:**
- `pkg` (required): Package to analyze (e.g., `redis@^4.0.0`, `axios`, `express@4.18.0`)

**Options:**

| Option | Alias | Type | Default | Description |
|--------|-------|------|---------|-------------|
| `--output` | `-o` | string | - | Path to save the JSON analysis report |
| `--minScore` | - | number | 0 | Minimum confidence score to include (0.0-1.0) |
| `--maxPerExport` | - | number | 20 | Maximum targets per export group |
| `--maxTotal` | - | number | 200 | Maximum total targets to include |
| `--llm` | - | boolean | false | Enable LLM judge pruning (requires OPENAI_API_KEY) |
| `--enhance` | - | boolean | false | Enable LLM enhancement with code verification |
| `--multi-version` | - | boolean | false | Analyze multiple versions (2 years back to current) |
| `--interactive` | - | boolean | true | Enable interactive category prompting when LLM is uncertain |
| `--assist` | - | boolean | false | Run LLM assistant after analysis and include notes |
| `--data-scoring` | - | boolean | true | Enable data requirements scoring to prioritize functions with span-relevant data |
| `--no-interactive` | - | boolean | false | Disable all interactive prompts |

**Environment Variables:**
- `DD_AI_GATEWAY`: Python AI gateway URL for LLM services
- `OPENAI_API_KEY`: OpenAI API key for direct LLM access
- `DD_DEBUG_DOCS`: Enable debug logging for documentation processing

**Examples:**
```bash
# Basic analysis
dd-apm-analyze analyze axios -o axios-report.json

# Enhanced analysis with LLM assistance
DD_AI_GATEWAY=true dd-apm-analyze analyze redis --enhance --assist -o redis-enhanced.json

# Multi-version analysis for API differences
dd-apm-analyze analyze express --multi-version --minScore 0.7 -o express-versions.json

# High-confidence targets only
dd-apm-analyze analyze mongoose --minScore 0.8 --maxTotal 50 -o mongoose-focused.json
```

#### `assist <question>`

Ask an LLM assistant about a package using optional analysis context.

**Usage:**
```bash
dd-apm-analyze assist <question> [options]
```

**Arguments:**
- `question` (required): Question to ask about the package or integration

**Options:**
- `--context`, `-c`: Path to analysis JSON report for context
- `--web`: Include brief web search context

**Examples:**
```bash
# Ask about instrumentation approach
dd-apm-analyze assist "How should I instrument Redis connection pooling?" -c redis-report.json

# General integration question
dd-apm-analyze assist "What are the key methods to trace in Express.js?" --web
```

#### `mine-keywords`

Extract and analyze keywords from existing integrations (internal command).

### Output Format

The analysis generates a JSON report with the following structure:

```json
{
  "library_name": "axios",
  "language": "nodejs", 
  "category": "http",
  "subcategory": "client",
  "capabilities": {
    "producer": false,
    "consumer": false
  },
  "similar_integration": "undici",
  "docs_signals": {
    "sources": {
      "readme": true,
      "docs": false,
      "changelog": true,
      "package_keywords": ["xhr", "http", "ajax", "promise"]
    },
    "matched_verbs": ["get", "post", "put", "delete", "request"]
  },
  "test_examples": {
    "setup_lines": [
      "const mod = require(`../../../versions/axios@${version}`)",
      "const http = require('http')",
      "// Server setup for client testing..."
    ],
    "action_lines": [
      "const response = await mod.get('http://localhost:3000/test')",
      "expect(response.status).to.equal(200)"
    ]
  },
  "targets": [
    {
      "export_path": "default",
      "function_name": "get",
      "module": "axios",
      "confidence_score": 0.95,
      "reasoning": "Primary HTTP client method"
    }
  ],
  "version_analysis": {
    "versionAnalyses": {
      "1.6.0": { /* version-specific analysis */ },
      "1.7.0": { /* version-specific analysis */ }
    },
    "apiDifferences": [
      {
        "type": "added",
        "version": "1.7.0", 
        "method": "getUri",
        "breaking": false
      }
    ]
  },
  "cautions": [],
  "assistant_notes": "LLM-generated integration advice"
}
```

---

## dd-apm-scaffold

**Purpose**: Generates complete APM integration projects from analysis reports, including instrumentation code, plugin classes, tests, and documentation.

### Description

The `dd-apm-scaffold` tool creates production-ready integration code by:
- Generating instrumentation shimming code with version-aware hooks
- Creating plugin classes with appropriate base classes (HttpClientPlugin, RouterPlugin, etc.)
- Scaffolding comprehensive test suites with category-specific patterns
- Setting up CI/CD configurations and documentation
- Applying automatic code linting and formatting
- Supporting subcategory-aware code generation

### Commands

#### `scaffold <report> <name>`

Scaffolds a new integration project from an analysis report.

**Usage:**
```bash
dd-apm-scaffold scaffold <report> <name> [options]
```

**Arguments:**
- `report` (required): Path to the analysis report JSON file
- `name` (required): Name of the integration (e.g., `redis`, `axios-custom`)

**Options:**

| Option | Alias | Type | Default | Description |
|--------|-------|------|---------|-------------|
| `--language` | `-l` | string | nodejs | Target language for scaffolding |

**Environment Variables:**
- `DD_AI_GATEWAY`: Enable LLM enhancement for generated code
- `OPENAI_API_KEY`: Alternative LLM access for code enhancement

**Examples:**
```bash
# Basic scaffolding
dd-apm-scaffold scaffold axios-report.json axios

# With LLM enhancement
DD_AI_GATEWAY=true dd-apm-scaffold scaffold redis-enhanced.json redis-v2

# Custom integration name
dd-apm-scaffold scaffold express-analysis.json express-custom -l nodejs
```

### Generated Structure

The scaffolder creates the following structure:

```
packages/
├── datadog-instrumentations/src/
│   └── {integration}.js              # Instrumentation hooks
├── datadog-plugin-{integration}/
│   ├── src/index.js                  # Plugin class
│   ├── test/index.spec.js            # Test suite
│   └── package.json                  # Package metadata
└── dd-trace/src/plugins/
    └── index.js                      # Updated plugin registry
```

### Features

- **Data Requirements Scoring**: Prioritizes instrumentation targets based on their ability to provide meaningful span data (URL, method, database queries, etc.)
- **Subcategory-Aware Generation**: HTTP clients get client-specific code, servers get server-specific code
- **Version-Aware Instrumentation**: Handles API differences across library versions
- **Automatic Linting**: All generated files are automatically linted and formatted
- **LLM Enhancement**: Optional AI-powered code improvement and verification
- **Test Pattern Matching**: Category-specific test patterns (client/server, producer/consumer)
- **Conservative Version Ranges**: Broad version coverage with runtime detection

---

## dd-apm-test-runner

**Purpose**: Executes tests for generated integrations with optional service dependencies and structured output for LLM consumption.

### Description

The `dd-apm-test-runner` tool provides:
- Automated test execution for specific plugins
- Docker service management for integration tests
- Structured output suitable for LLM analysis
- Timeout and cleanup management
- Verbose logging for debugging

### Commands

#### `test <plugin-id>`

Runs tests for a specific plugin/integration.

**Usage:**
```bash
dd-apm-test-runner test <plugin-id> [options]
```

**Arguments:**
- `plugin-id` (required): The normalized plugin ID (e.g., `axios`, `redis`, `postgres`)

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--service`, `-s` | string | - | Docker service to start before testing |
| `--no-cleanup` | boolean | false | Skip docker cleanup after tests |
| `--timeout` | number | 300 | Test timeout in seconds |
| `--verbose` | boolean | false | Show detailed output |

**Examples:**
```bash
# Simple test run
dd-apm-test-runner test axios

# Test with Redis service
dd-apm-test-runner test redis -s redis

# Test with custom timeout and verbose output
dd-apm-test-runner test postgres -s postgres --timeout 600 --verbose

# Test without cleanup (for debugging)
dd-apm-test-runner test mongodb -s mongodb --no-cleanup
```

### Test Process

1. **Service Startup** (if specified): `docker-compose up -d {service}`
2. **Test Execution**: `PLUGINS={plugin-id} yarn test:plugins:ci`
3. **Result Collection**: Structured output with success/failure status
4. **Cleanup** (unless disabled): Stop and remove docker containers

### Output Format

```json
{
  "success": true,
  "pluginId": "axios", 
  "service": null,
  "duration": 45.2,
  "testResults": {
    "passed": 12,
    "failed": 0,
    "skipped": 1
  },
  "output": "Test execution logs..."
}
```

---

## Data Requirements System

The Data Requirements System is a key innovation that evaluates instrumentation targets based on their ability to provide meaningful span data. This ensures that instrumentation efforts focus on functions that will create high-quality, informative distributed tracing spans.

### How It Works

Instead of just analyzing function names and patterns, the system considers what data each function can realistically extract:

- **HTTP Clients**: Prioritizes functions that can provide URL, method, headers, and timeout information
- **Database Clients**: Focuses on functions with access to queries, connection info, and parameters
- **Messaging Systems**: Targets functions with topic, message, and routing data
- **Cache Systems**: Emphasizes functions with command, key, and value access

### Scoring Algorithm

The system combines traditional confidence scores with data availability:

```
Final Score = (Original Score × 60%) + (Data Score × 40%)
```

### Data Categories

- **Critical Data** (1.0 weight): Must-have information for meaningful spans
- **Important Data** (0.7 weight): Significantly improves span quality
- **Optional Data** (0.3 weight): Nice-to-have, minimal impact on span value

### Example Results

```json
{
  "function_name": "get",
  "confidence_score": 0.88,
  "data_score": 0.8,
  "data_availability": {
    "critical": 0.9,
    "important": 0.8, 
    "optional": 0.6
  },
  "data_reasoning": "2/2 critical data types available, 2/2 important data types available"
}
```

### Supported Integration Types

- `http-client`: axios, got, node-fetch, undici
- `http-server`: express, koa, fastify, hapi
- `database-client`: mysql, postgres, mongodb, sequelize
- `cache-client`: redis, memcached, ioredis
- `messaging-producer`: kafka producer, rabbitmq publisher
- `messaging-consumer`: kafka consumer, rabbitmq subscriber

For detailed information, see [`DATA_REQUIREMENTS_SYSTEM.md`](dd-apm-analyze/DATA_REQUIREMENTS_SYSTEM.md).

---

## Integration Examples

### Complete Workflow Example

```bash
# 1. Analyze a package with full enhancement
DD_AI_GATEWAY=true dd-apm-analyze analyze fastify \
  --enhance --assist --multi-version \
  --minScore 0.7 -o fastify-analysis.json

# 2. Scaffold the integration
DD_AI_GATEWAY=true dd-apm-scaffold scaffold fastify-analysis.json fastify

# 3. Run tests to verify the integration
dd-apm-test-runner test fastify --verbose

# 4. Run with service dependency if needed
dd-apm-test-runner test postgres -s postgres --timeout 300
```

### LLM Integration Example

```bash
# Analyze with LLM assistance
DD_AI_GATEWAY=true dd-apm-analyze analyze mongoose \
  --enhance --assist --interactive -o mongoose.json

# Ask follow-up questions
dd-apm-analyze assist \
  "Should I instrument both connection and query methods?" \
  -c mongoose.json

# Generate enhanced code
DD_AI_GATEWAY=true dd-apm-scaffold scaffold mongoose.json mongoose
```

---

## MCP Tool Specifications

### Tool Schema Format

Each tool follows the MCP standard with the following schema structure:

```json
{
  "name": "dd_apm_analyze",
  "description": "Analyze Node.js packages for APM instrumentation targets",
  "inputSchema": {
    "type": "object",
    "properties": {
      "package": {
        "type": "string",
        "description": "Package name with optional version (e.g., 'axios@1.0.0')"
      },
      "output_path": {
        "type": "string", 
        "description": "Path to save analysis report JSON"
      },
      "min_score": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0,
        "description": "Minimum confidence score threshold"
      },
      "enhance": {
        "type": "boolean",
        "default": false,
        "description": "Enable LLM enhancement and code verification"
      },
      "multi_version": {
        "type": "boolean", 
        "default": false,
        "description": "Analyze multiple versions for API differences"
      }
    },
    "required": ["package"]
  }
}
```

### Error Handling

All tools implement consistent error handling:

- **Exit Code 0**: Success
- **Exit Code 1**: General failure
- **Exit Code 2**: Invalid arguments
- **Structured Errors**: JSON error objects when applicable

### Environment Requirements

- **Node.js**: >= 14.0.0
- **Python**: >= 3.8 (for LLM bridge)
- **Docker**: Required for test-runner service dependencies
- **Network**: Internet access for NPM registry and LLM services

### Performance Characteristics

- **dd-apm-analyze**: 30-120 seconds per package (depending on size and LLM usage)
- **dd-apm-scaffold**: 5-30 seconds per integration
- **dd-apm-test-runner**: 30-600 seconds (depending on test complexity)

---

## Best Practices

### Analysis Best Practices

1. **Start with Enhancement**: Use `--enhance` for better quality analysis
2. **Use Multi-Version**: Enable `--multi-version` for libraries with significant API changes
3. **Set Appropriate Thresholds**: Use `--minScore 0.7` for production integrations
4. **Save Reports**: Always use `-o` to save analysis for later use

### Scaffolding Best Practices

1. **Enable LLM Enhancement**: Set `DD_AI_GATEWAY=true` for better code quality
2. **Review Generated Code**: Always review generated instrumentation logic
3. **Test Immediately**: Run tests after scaffolding to verify functionality
4. **Customize as Needed**: Generated code is a starting point, customize for specific needs

### Testing Best Practices

1. **Use Services**: Test with actual service dependencies when possible
2. **Enable Verbose**: Use `--verbose` for debugging test failures
3. **Appropriate Timeouts**: Set realistic timeouts for complex integrations
4. **Clean Up**: Don't use `--no-cleanup` in CI environments

---

This documentation provides comprehensive guidance for using the APM integration scaffolding tools effectively. The tools are designed to work together as a pipeline, from analysis through scaffolding to testing, enabling rapid development of high-quality APM integrations.
