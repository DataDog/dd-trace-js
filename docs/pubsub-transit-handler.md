sed offtest### Google Cloud Pub/Sub push: why the new transit handler and synthetic delivery span

#### What changed
- Replaced the older push instrumentation (shimmer/wrapping and internal `pubsub.receive`) with a diagnostics-channel based transit handler (`pubsub-transit-handler`) that subscribes to `apm:http:server:request:intercept`.
- Enhanced the gRPC client plugin to detect `google.pubsub.v1.Publisher/Publish` and inject a synthetic delivery span context into Pub/Sub message attributes.
- On the consumer, the transit handler creates and immediately finishes a synthetic span named `pubsub.delivery` representing time spent inside Google Pub/Sub infrastructure (storage, scheduling, delivery), and makes the consumer `http.request` span a child.

#### Why this is better than the old approach
- **Reliability (diagnostics channels vs shimmer)**: Uses shared channels instead of patching `http` internals. This is less brittle, plays nicely with other instrumentations, and avoids middleware order/implementation coupling.
- **Linear, end‑to‑end trace**: The injected synthetic context bridges the producer and consumer so traces are contiguous across the Pub/Sub "invisible" hop.
- **Clear semantics**: Removes `pubsub.receive` (Datadog-internal) and introduces `pubsub.delivery`, which maps to a real-world concept users care about: the infrastructure gap.
- **Performance and safety**: Fast request detection with minimal overhead; defensive guards for body size and `headersSent`; avoids double-parsing bodies.
- **Tag consistency**: Ensures `pubsub.topic`, `gcloud.project_id`, `pubsub.subscription`, and `pubsub.delivery_method` are present on relevant spans.
- **Future-proof**: Works for both traditional push and Eventarc CloudEvents; easier to extend and test.

#### What is `pubsub.delivery` and how is it created?
- On publish (producer): the gRPC client instrumentation creates a synthetic delivery context (trace id, span id, start time) and injects it into Pub/Sub message attributes via gRPC metadata.
- On push (consumer): the transit handler extracts those attributes and creates a `pubsub.delivery` span with `startTime` from the producer and `endTime` at receipt, then immediately finishes it and starts the consumer `http.request` as a child.
- Span tags include:
  - `component: google-cloud-pubsub`
  - `span.kind: internal`
  - `span.type: pubsub`
  - `gcloud.project_id`, `pubsub.topic`, `pubsub.subscription`, `pubsub.delivery_method` (push|eventarc)
  - CloudEvents extras when present: `cloudevents.source`, `cloudevents.type`, `eventarc.trigger: pubsub`

#### Value to users
- **Makes the invisible visible**: Quantifies time within Pub/Sub infrastructure, enabling SLOs/alerts on delivery latency and faster incident triage.
- **Producer→consumer correlation**: Clear, linear lineage helps answer "who published this?" and "why is this message late?" without manual log stitching.
- **Actionable triage**: Distinguish infra delay (`pubsub.delivery`) from app delay (`http.request` → `express.request` → business spans). Retries/redeliveries can be tagged for visibility.
- **Zero app changes**: Works automatically with existing `http`/`express` instrumentation; no app-level code needed.

#### Resulting span hierarchy (high-level)
- Producer
  - `google.pubsub.v1.Publisher/Publish` (gRPC client)
    - `pubsub.googleapis.com POST` (HTTP client)
- Synthetic infrastructure
  - `pubsub.delivery` (delivery gap)
    - `http.request` (consumer receive)
      - `express.request`
      - your business spans

Note: The HTTP client call to `pubsub.googleapis.com` belongs to the producer’s infrastructure and is not a child of `pubsub.delivery` (which represents the period after publish until consumer receipt).

#### Operational considerations
- Trust only after confident Pub/Sub detection (headers/paths), to avoid spoofed `x-dd-delivery-*` headers.
- Clock skew: clamp if `end < start` and optionally tag a clamp flag for transparency.
- Redeliveries: tag when `deliveryAttempt` or equivalent is present.
- Provide a config flag to enable/disable transit handling and synthetic spans if needed.

#### Migration notes
- The internal `pubsub.receive` span is replaced by `pubsub.delivery`.
- Old temporary files and the obsolete push wrapper were removed/renamed; tests updated accordingly.
- No application changes are required; the plugin auto-subscribes via the diagnostics channel loader.

#### Placement: why HTTP server + gRPC client?
- Producer side: publish calls flow through gRPC. Wrapping the gRPC client for `google.pubsub.v1.Publisher/Publish` is the most accurate and universal place to detect a publish and inject delivery context. It avoids guessing at higher levels and works across libraries that ultimately use gRPC.
- Consumer side: push delivery arrives as HTTP POST (traditional push) or as Eventarc CloudEvents, both via HTTP servers. Subscribing to `apm:http:server:request:intercept` guarantees early, reliable interception without brittle monkey-patching, and it is agnostic to frameworks (Express/Koa/Hapi, etc.).
- Alternatives (less ideal): hooking Express middleware order, patching `http.Server.prototype.emit`, or instrumenting downstream libraries. These are more fragile and may miss requests.

#### Overhead and performance expectations
- HTTP intercept listener
  - For non-Pub/Sub requests: a quick header/path check and early return. Expected overhead: microseconds per request; effectively noise.
  - For Pub/Sub requests: small object allocations for tags and a single `startSpan` for `http.request`. The synthetic `pubsub.delivery` span is created and finished immediately, incurring negligible lifecycle overhead.

- Request body handling
  - The handler does not re-parse bodies if a meaningful `req.body` already exists. It relies on upstream body parsers when present and performs minimal JSON parsing only when necessary to extract message attributes (traditional push) or CloudEvents fields.
  - Complexity is linear in payload size; typical Pub/Sub push bodies are small. With size guards and early bail-outs, expected CPU overhead is small (a single `JSON.parse`) and memory overhead equals payload size already in flight.
  - Safety: respects `headersSent` and body-size limits; avoids double-read of streams.

- gRPC client wrapping
  - Adds a fast check (`isPubSubPublishOperation`) and sets a few metadata keys. No additional network calls, no extra spans are created on the producer; only a lightweight synthetic context is generated.
  - Expected overhead: microseconds per publish call; negligible compared to network I/O.

- Interactions with existing plugins
  - The transit handler and gRPC wrapper are additive and non-blocking. They do not alter request/response bodies, do not delay I/O, and do not interfere with existing `http`, `express`, or `grpc` instrumentations.
  - If disabled via config, the rest of the instrumentation stack continues to operate unchanged.

