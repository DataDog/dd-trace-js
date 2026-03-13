# datadog-plugin-lambda

Server-side AWS Lambda plugin for `dd-trace-js`. This plugin traces incoming Lambda invocations, creates inferred spans for upstream services, extracts distributed trace context from event sources, and emits enhanced Lambda metrics.

## Background

This plugin replaces the standalone [`datadog-lambda-js`](https://github.com/DataDog/datadog-lambda-js) library. All server-side Lambda tracing functionality has been migrated into dd-trace-js as a first-class plugin, following the same architecture as `datadog-plugin-azure-functions` and other integrations.

Key motivations:
- Eliminates the "double-wrapping" problem (datadog-lambda-js wrapping dd-trace wrapping user code)
- Uses `AWS_LAMBDA_EXEC_WRAPPER` for clean auto-instrumentation (same approach as OpenTelemetry)
- Consolidates all tracing logic into a single package

## Architecture

```
AWS_LAMBDA_EXEC_WRAPPER=/opt/datadog_wrapper
  -> Sets DD_LAMBDA_HANDLER="$_HANDLER"
  -> Sets NODE_OPTIONS="--require /opt/nodejs/node_modules/dd-trace/init"
  -> exec "$@" (starts the Lambda runtime)
  -> dd-trace/init runs: tracer initializes, registers lambda instrumentation hook
  -> Runtime loads user handler module -> addHook intercepts, wraps handler function
  -> Each invocation: instrumentation emits dc.tracingChannel events -> plugin creates spans/metrics
```

### Components

| Component | Path | Role |
|-----------|------|------|
| **Instrumentation** | `packages/datadog-instrumentations/src/lambda.js` | Hooks into handler module loading via `addHook`, wraps the handler, emits `dc.tracingChannel('datadog:lambda:invoke')` events |
| **Plugin** | `packages/datadog-plugin-lambda/src/index.js` | `TracingPlugin` subclass that subscribes to channel events and creates spans, extracts context, emits metrics |
| **Layer wrapper** | `lambda-layer/datadog_wrapper` | Shell script for `AWS_LAMBDA_EXEC_WRAPPER` — sets env vars and execs the runtime |
| **Layer build** | `scripts/build-lambda-layer.sh` | Packages dd-trace + wrapper into a Lambda Layer zip |

### Plugin Lifecycle

The plugin extends `TracingPlugin` with four lifecycle methods:

- **`bindStart`** — Parses event source, extracts trace context, creates inferred span (if enabled), starts `aws.lambda` span, sets up timeout detection, patches console for log injection, sends invocation metric
- **`asyncStart`** — Extracts HTTP status from result, tags spans with payload data, creates cold start trace spans, adds span pointers, finishes inferred span
- **`error`** — Attaches error to the active span
- **`asyncEnd`** — Sends X-Ray subsegment, flushes DogStatsD, clears timeout timer, unpatches console

## Supported Event Sources

Trace context extraction and inferred span creation for:

- API Gateway (REST v1, HTTP v2, WebSocket)
- Application Load Balancer (ALB)
- Lambda Function URL
- SQS (direct, SNS-via-SQS, EventBridge-via-SQS)
- SNS
- Kinesis Data Streams
- DynamoDB Streams
- S3
- EventBridge
- Step Functions
- Lambda `clientContext.custom`
- X-Ray (fallback)

## Configuration

All configuration is via environment variables:

| Env Var | Default | Description |
|---------|---------|-------------|
| `DD_ENHANCED_METRICS` | `true` | Emit enhanced Lambda metrics (invocations, errors, cold starts) via DogStatsD |
| `DD_TRACE_MANAGED_SERVICES` | `true` | Create inferred spans for upstream services (API GW, SQS, SNS, etc.) |
| `DD_CAPTURE_LAMBDA_PAYLOAD` | `false` | Tag spans with request/response payloads |
| `DD_CAPTURE_LAMBDA_PAYLOAD_MAX_DEPTH` | `10` | Max recursion depth for payload tagging |
| `DD_MERGE_XRAY_TRACES` | `false` | Send X-Ray subsegments for hybrid tracing |
| `DD_LOGS_INJECTION` | `true` | Patch console methods to inject trace context into logs |
| `DD_COLD_START_TRACING` | `true` | Create spans for cold start module loading |
| `DD_COLD_START_TRACE_SKIP_LIB` | `""` | Comma-separated module name prefixes to skip in cold start traces |
| `DD_MIN_COLD_START_DURATION` | `3` | Minimum duration (ms) for a module to appear in cold start traces |
| `DD_ENCODE_AUTHORIZER_CONTEXT` | `true` | Encode trace context into API Gateway authorizer response |
| `DD_DECODE_AUTHORIZER_CONTEXT` | `true` | Decode trace context from API Gateway authorizer context |
| `DD_TRACE_AWS_ADD_SPAN_POINTERS` | `true` | Add span pointers for S3/DynamoDB operations |
| `DD_SERVICE_MAPPING` | `""` | Remap inferred span service names (e.g., `lambda_api_gateway:my-api`) |

## Usage

### Auto-instrumentation via Lambda Layer

1. Build the layer:
   ```bash
   ./scripts/build-lambda-layer.sh
   ```

2. Publish to AWS:
   ```bash
   aws lambda publish-layer-version \
     --layer-name datadog-node \
     --zip-file fileb://lambda-layer.zip \
     --compatible-runtimes nodejs18.x nodejs20.x nodejs22.x
   ```

3. Configure your Lambda function:
   - Add the layer
   - Set `AWS_LAMBDA_EXEC_WRAPPER=/opt/datadog_wrapper`
   - Set `DD_SITE`, `DD_API_KEY` (or use the Datadog Agent Extension)

### Manual instrumentation

For cases where `datadog-lambda-js` is used as a programmatic wrapper (not via the layer), the instrumentation also hooks into `require('datadog-lambda-js')` and wraps its `datadog()` export to emit tracing channel events.

## Source Map

```
src/
  index.js                  # LambdaPlugin (TracingPlugin subclass)
  trigger.js                # Event source detection + trigger tag extraction
  span-inferrer.js          # Inferred span creation for 8+ event sources
  trace-context-extractor.js # Multi-source context extraction pipeline
  extractors/
    http.js                 # API GW v1/v2, ALB, Lambda URL, authorizer
    sqs.js                  # SQS message attributes
    sns.js                  # SNS message attributes
    kinesis.js              # Base64-decoded Kinesis record data
    event-bridge.js         # EventBridge detail._datadog
    step-function.js        # Step Function context (SHA-256 ID generation)
    lambda-context.js       # Lambda clientContext.custom
  xray-service.js           # X-Ray subsegment + trace ID conversion
  cold-start.js             # Cold start state tracking
  cold-start-tracer.js      # Cold start span tree from require nodes
  enhanced-metrics.js       # DogStatsD metric emission
  dogstatsd.js              # Lambda-specific UDP DogStatsD client
  console-patcher.js        # Console log injection
  handler-utils.js          # Handler promisification, payload tagging, batch failures
  event-type-guards.js      # Event source type detection predicates
  arn.js                    # ARN parsing
  span-pointers.js          # S3/DynamoDB span pointer hashing
```

## Testing

```bash
# Unit tests
./node_modules/.bin/mocha packages/datadog-plugin-lambda/test/*.spec.js

# Plugin test runner
PLUGINS="lambda" npm run test:plugins
```
