# Python/JavaScript LLMObs parity harness

This is developer tooling for comparing LLMObs span events emitted by the Python
and JavaScript tracers. It is intentionally not wired into CI.

## Run

The harness needs Node >= 22, Python, pip, and the repository's test agent:

```bash
docker compose up -d testagent
PLUGINS=openai yarn services
PLUGINS=anthropic yarn services
node packages/dd-trace/test/llmobs/parity/cli.js run
```

The first run creates `.parity-venv/` and installs `ddtrace`, `openai`, and
`anthropic` into it. Captures are regenerated under `captures/`; the report is
written to `report.md`.

Individual commands:

```bash
node packages/dd-trace/test/llmobs/parity/cli.js capture \
  --sdk js --integration openai --scenario chat-completion
node packages/dd-trace/test/llmobs/parity/cli.js diff --integration openai
node packages/dd-trace/test/llmobs/parity/cli.js report
node packages/dd-trace/test/llmobs/parity/cli.js import-vcrpy \
  --provider anthropic \
  --cassette /home/ubuntu/repos/dd-trace-py/tests/contrib/anthropic/cassettes/anthropic_completion_stream.yaml \
  --output packages/dd-trace/test/llmobs/parity/fixtures/anthropic/messages-stream.json
```

The importer uses the repository's existing `js-yaml` dependency. It handles
vcrpy `interactions`, string/binary bodies, gzip bodies, and SSE recordings.

## Adding a scenario

Add a fixture at `fixtures/<integration>/<scenario>.json` and paired scripts at
`scenarios/<integration>/<scenario>.js` and `.py`. The fixture is a queue of
responses matched by method and URL path. The stub provider returns the exact
body to both SDKs, including SSE framing, so provider credentials are not used.

The capture command starts the local stub, runs one SDK subprocess, flushes
LLMObs, then retrieves the test-agent requests from
`/test/session/requests`. It starts a test session and uses before/after request
list lengths to isolate each capture; this works with test-agent versions that
reject the session token header on the requests endpoint.

Normalization drops `trace_id`, `span_id`, `parent_id`, `start_ns`, `duration`,
and `_dd` trace/span identity fields. IDs are replaced with start-order
ordinals. Dotted keys in `meta` are canonicalized to nested objects so
`meta["span.kind"]` and `meta.span.kind` compare equally. Tags whose keys are
environment-derived are dropped, then compared as sets; `agent_service` remains
visible. The complete list is exported as `IGNORED_FIELDS` from `normalize.js`.

Diffs pair spans by normalized tree position and `meta.span.kind`. Accepted
field paths may be recorded in `allowlist.json`; use object entries with
`path` and `reason` when a reason should appear in the report.

This harness verifies what each SDK emits when given identical provider
responses. Because the provider is a stub and request bodies are matched only
by method/path, it does **not** verify request-side behavior.

## Known real divergences found on first run

- Anthropic and OpenAI tool calls: Python emits `meta.tool_definitions`;
  JavaScript does not.
- OpenAI streaming: Python emits `meta.metadata.stream_options`; JavaScript
  does not.
- OpenAI chat, streaming, and tool calls, plus embeddings: JavaScript emits
  `metrics.reasoning_output_tokens: 0`; Python does not.
- Every Python span carries the `agent_service:parity` tag; JavaScript does not.
