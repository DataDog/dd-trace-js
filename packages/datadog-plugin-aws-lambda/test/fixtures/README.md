# Lambda helper source provenance

The private Lambda helpers were ported from
[DataDog/datadog-lambda-js at da9fc3c0c9dca00893f70c9a1bd5ac1254af3b01](https://github.com/DataDog/datadog-lambda-js/tree/da9fc3c0c9dca00893f70c9a1bd5ac1254af3b01).
The relevant files and `event_samples/` were compared with upstream `main` at
`bb5266a00e72eba0edcfe8d73256fe70461547c4` on 2026-11-12: no differences. The source pin is unchanged.
The separately pinned completion adapter is outside this port.

| Source at the pin | Destination relative to this plugin |
| --- | --- |
| `src/utils/event-type-guards.ts` | `src/event-type-guards.js` |
| `src/utils/event-validator.ts` | The same guards module; shared predicates have one implementation, with MSK and Durable predicates added |
| `src/trace/constants.ts` (`apiGatewayEventV2` only) | Private version constant in `src/event-type-guards.js` |
| `src/trace/trigger.ts` | `src/trigger.js` |
| `src/utils/arn.ts` | `src/arn.js` |
| `src/trace/trigger.spec.ts` | `test/trigger.spec.js`; all four source cases and their response/fixture matrices retained |
| `src/utils/arn.spec.ts` | `test/arn.spec.js`; all five source cases retained |
| `event_samples/*.json` listed below | `test/fixtures/`, copied byte for byte |

The trigger spec uses `api-gateway-v1.json`, `api-gateway-v2.json`, `lambda-function-urls.json`,
`application-load-balancer.json`, `cloudfront.json`, `cloudwatch-events.json`, `cloudwatch-logs.json`,
`custom.json`, `dynamodb.json`, `kinesis.json`, `s3.json`, `sns.json`, `sqs.json` and `states.json`.
Additional boundary tests use `api-gateway-wss.json`, `eventbridge.json`, `eventbridge-sqs.json` and
`snssqs.json`. Fixture names are retained even where the source's API version naming is counterintuitive.
These are source event samples, not generated outputs or recaptured migration goldens.

## Adaptation boundaries

- TypeScript/Jest becomes private CommonJS and Mocha with `node:assert/strict`; no dependency or public API is added.
- The validator class is replaced with direct function imports. Its `isAPIGatewayWebSocketEvent` maps to
  `isAPIGatewayWebsocketEvent`; the guard's `isEBSQSEvent` maps to `isEventBridgeSQSEvent`.
  `parseEventSourceSubType` becomes `parseEventSourceSubtype` to match repository naming conventions.
- Identical SQS checks share `isSQSEvent`. One-use ARN property accessors are inlined into source-string dispatch.
  The existing AWS SDK partition helper is private and has different missing-region behavior; importing that
  plugin or changing its API would broaden this port. The Lambda contract remains local.
- Debug diagnostics use the tracer logger with printf formatting. The shim logger and its configuration are not copied.
- JavaScript style conversions preserve branch order, tag keys, undefined values and alias/version coercion.
  The Step Functions `typeof ... === 'object'` checks deliberately include null, just as the pin does;
  narrow lint exceptions prevent an autofix from changing this behavior. Metadata extraction still catches failures.

`event-type-guards.spec.js` and `trigger-boundaries.spec.js` add source-backed coverage for missing discriminators,
first-record selection, nested SNS/EventBridge-over-SQS bodies, Step Functions envelopes, malformed inputs,
MSK/Durable predicates, classification/subtype precedence, partitions, HTTP tags/status and input immutability.
ARN boundary cases cover numeric and named qualifiers, `$LATEST`, undefined versions and malformed strings.
The same 70 helper cases were also run locally against the committed TypeScript source, once with its free
functions and once with the overlapping validator methods. Both controls passed.

Nested SQS events remain classified as SQS; MSK, Durable and AppSync predicates do not add trigger names
the source does not define. These tests establish helper behavior. Invocation metadata, parent extraction,
inferred spans, release-line compatibility, deployed behavior and migration snapshot equivalence require
separate validation.
