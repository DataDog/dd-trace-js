This benchmark measures the per-AWS-SDK-call work in
`packages/datadog-plugin-aws-sdk/src/base.js`, the EventBridge / Lambda service
plugins, and the Bedrock runtime extraction helpers. Every traced AWS SDK call
hits the base-plugin code, so per-call savings compound for a large customer
subset; Bedrock LLM users hit the extraction path on every response.

The plugin internals are exercised directly via `Object.create(Plugin.prototype)` so
the hot loop never touches diagnostic channels or a real tracer; a tiny stub
`tracer.inject` populates the carrier the same way the real propagator would.

Variants:

- `extract-response-body` — the per-response `extractResponseBody` filter chain.
- `eventbridge-inject-detail` — the EventBridge `requestInject` JSON-merge path.
- `lambda-inject-no-context` — the Lambda `requestInject` ClientContext build.
- `add-response-tags` — the per-response `addResponseTags` tag literal + `addTags`
  dispatch over a megamorphic mix of eight realistic AWS service response shapes
  (DDB scan / Kinesis put / SQS receive / S3 list / SNS publish / Lambda invoke /
  Pub/Sub subscribe / DDB getItem). Tracks the cost of building the per-response
  `tags` literal and the `'span.kind': 'client'` re-tag.
- `bedrock-extract-text` — the `extractTextAndResponseReason` decode of an Amazon
  Titan response body. Measures the `Buffer.from(response.body).toString('utf8')`
  + `JSON.parse` + provider-switch sequence that runs on every Bedrock
  `invokeModel` response.
