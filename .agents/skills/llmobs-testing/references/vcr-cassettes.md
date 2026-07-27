# VCR cassettes

The VCR proxy records provider HTTP traffic once and replays it afterwards, so specs run
deterministically without credentials.

## The proxy is the test-agent container

There is no VCR script in this repo. Start the container from the repo root before running any
cassette-backed spec:

```bash
docker compose up -d testagent
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9126/info   # 200 once ready
```

Skip this and every call fails as `ECONNREFUSED 127.0.0.1:9126`. SDKs that retry report their own
wrapper error instead, which reads like a provider outage rather than missing infrastructure. CI starts
the same container and waits on the same `/info` endpoint via `.github/actions/testagent/start`.

## Point the client at the proxy

One path segment per provider: `http://127.0.0.1:9126/vcr/{provider}`. The option name is the
SDK's, not ours — `baseURL` for openai, `endpoint` for azure-openai, `endpoint: { url }` for
bedrock through aws-sdk, `httpOptions.baseUrl` for google-genai.

Keep the key falling back to a placeholder so replay works without credentials:

```javascript
new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? 'test-api-key',
  baseURL: 'http://127.0.0.1:9126/vcr/openai',
})
```

## Cassettes live in one shared tree

`packages/dd-trace/test/llmobs/cassettes/{provider}/` — not beside the spec.
`docker-compose.yml` mounts that directory at the container's `VCR_CASSETTES_DIRECTORY`.

Names are generated as `{provider}_{path}_{method}_{hash}`, so you never choose or rename one. The
hash covers the request, which means editing a prompt in a spec orphans its cassette and requires a
new recording. Both `.json` and `.yaml` files are in the tree and both replay, so take whichever
format a recording produces; each request is stored once, in one format, so a cassette never has a
twin in the other. Binary and multipart bodies live inside JSON cassettes, base64-encoded behind a
`base64:` prefix.

Six providers record without any configuration (openai, anthropic, genai, azure-openai, deepseek,
bedrock-runtime), which is every cassette directory except one. A provider the agent cannot resolve
from its name needs an entry in `VCR_PROVIDER_MAP` in `docker-compose.yml`, and the seventh directory
is that worked example: `claude-agent-sdk=https://api.anthropic.com`.

## Recording

1. Export the real provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …). For aws-sdk providers,
  uncomment `AWS_SECRET_ACCESS_KEY` in the testagent service and restart it.
2. Run the spec. A request with no cassette is recorded; one with a cassette is replayed, so
  re-recording means deleting exactly the cassette in question — never the provider directory.
3. Commit the new files with the spec that produced them.

## Non-deterministic fields break replay — normalize, never loosen the assertion

A body that carries a request id, a timestamp, a version string, or generated agent text will not
match on replay. Strip it in `docker-compose.yml`, where the other normalizers already live:

- `VCR_JSON_BODY_NORMALIZERS` — JSON paths, e.g. `metadata.user_id`.
- `VCR_BODY_REGEX_NORMALIZERS` — regexes, for values embedded in prose bodies (agent ids,
  `<usage>` blocks, tool descriptions, client version markers).

A cassette that replays locally but fails in CI is almost always a field that needs one of these.

## Running the specs

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
PLUGINS=openai npm run test:llmobs:plugins   # one integration; alternation: "openai|anthropic"
npm run test:llmobs:sdk                      # everything except the plugin specs
```

`PLUGINS` is matched as a glob alternation against
`packages/dd-trace/test/llmobs/plugins/@(${PLUGINS})/*.spec.js`.

`Cannot find module '…/versions/<pkg>@<version>'` is a missing version fixture, not a broken spec:
`PLUGINS=<pkg> yarn services` installs it. The fixtures live in a gitignored `versions/` directory at
the repo root, so a fresh worktree has none of them.
