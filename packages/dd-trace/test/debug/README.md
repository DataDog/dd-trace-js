# Channel Debug Patch

A debugging tool for dd-trace-js tests that logs diagnostic channel events, span lifecycle, shimmer wraps, and code rewrites.

## Quick Start

```bash
# Enable debug logging for all tests
TEST_CHANNEL_DEBUG=true PLUGINS=express yarn test:plugins

# Filter to specific patterns (supports wildcards)
TEST_CHANNEL_DEBUG=true TEST_CHANNEL_FILTER="*bullmq*" PLUGINS=bullmq yarn test:plugins

# Show channel message data
TEST_CHANNEL_DEBUG=true TEST_CHANNEL_SHOW_DATA=true PLUGINS=http yarn test:plugins
```

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `TEST_CHANNEL_DEBUG` | Enable debug logging | `true` |
| `TEST_CHANNEL_FILTER` | Filter pattern (supports `*` wildcards) | `*bullmq*`, `apm:express*`, `*:start` |
| `TEST_CHANNEL_SHOW_DATA` | Show channel message payloads | `true` |
| `TEST_CHANNEL_VERBOSE` | Show span tags in lifecycle logs | `true` |
| `NO_COLOR` | Disable colored output | `1` |
| `FORCE_COLOR` | Force colored output (for non-TTY) | `1` |

## Log Types

### `[SUB]` - Channel Subscribe
Logged when code subscribes to a diagnostic channel.
```
[+493ms] [SUB] tracing:orchestrion:bullmq:Queue_add:start ← anon
```

### `[PUB]` - Channel Publish
Logged when a message is published to a channel. Shows `(no subscribers)` if nobody is listening.
```
[+644ms] [PUB] tracing:orchestrion:bullmq:Queue_add:end (no subscribers)
```

### `[TRACEPROMISE]` / `[TRACESYNC]` / `[TRACECALLBACK]` - TracingChannel
Logged when tracing channel methods are called.
```
[+621ms] [TRACEPROMISE] orchestrion:bullmq:Queue_add 3.55ms
```

### `[WRAP]` - Shimmer Wrap
Logged when shimmer wraps a function.
```
[+312ms] [WRAP] [Router].use
```

### `[REWRITE]` - Code Rewrite
Logged when the orchestrion-style rewriter transforms code.
```
[+511ms] [REWRITE] bullmq Queue.add tracePromise
[+520ms] [REWRITE] bullmq Worker.callProcessJob tracePromise
```

### `[SPAN:START]` / `[SPAN:END]` - Span Lifecycle
Logged when spans are created and finished. Includes a short span ID (last 8 hex chars) for correlating parallel spans.
```
[+592ms] [SPAN:START] bullmq.add [a1b2c3d4] service=test-bullmq resource=test-queue
[+601ms] [SPAN:END] bullmq.add [a1b2c3d4]
[+605ms] [SPAN:END] bullmq.processJob [e5f6a7b8] error=Connection refused
```

## Filter Patterns

The filter supports simple wildcard matching:

| Pattern | Matches |
|---------|---------|
| `*bullmq*` | Contains "bullmq" |
| `apm:express*` | Starts with "apm:express" |
| `*:start` | Ends with ":start" |
| `bullmq` | Contains "bullmq" (default) |

The filter applies to:
- Channel names for SUB/PUB events
- TracingChannel names
- Module/method names for WRAP events
- Module/target names for REWRITE events
- Span names for SPAN events

## Output to File

When stderr is redirected to a file, colors are automatically disabled:

```bash
# Both stdout and stderr to file
TEST_CHANNEL_DEBUG=true PLUGINS=bullmq yarn test:plugins &>/tmp/debug.txt

# See output live AND save to file
TEST_CHANNEL_DEBUG=true PLUGINS=bullmq yarn test:plugins 2>&1 | tee /tmp/debug.txt

# Force no colors even in terminal
NO_COLOR=1 TEST_CHANNEL_DEBUG=true PLUGINS=bullmq yarn test:plugins
```

## Example Output

```
[channel-debug] Filter: *bullmq* | Verbose: false
[+274ms] [REWRITE] bullmq FlowProducer.add tracePromise
[+286ms] [REWRITE] bullmq Queue.add tracePromise
[+286ms] [REWRITE] bullmq Queue.addBulk tracePromise
[+294ms] [REWRITE] bullmq Worker.callProcessJob tracePromise
[+493ms] [SUB] tracing:orchestrion:bullmq:Queue_add:start ← anon
[+493ms] [SUB] tracing:orchestrion:bullmq:Queue_add:asyncEnd ← anon
[+493ms] [SUB] tracing:orchestrion:bullmq:Queue_add:error ← anon
[+493ms] [SUB] tracing:orchestrion:bullmq:Queue_add:finish ← anon
[+592ms] [SPAN:START] bullmq.add [a1b2c3d4] service=test-bullmq resource=test-queue
[+601ms] [SPAN:END] bullmq.add [a1b2c3d4]
[+605ms] [SPAN:START] bullmq.processJob [e5f6a7b8] service=test-bullmq resource=test-queue
[+605ms] [SPAN:END] bullmq.processJob [e5f6a7b8]
[+621ms] [TRACEPROMISE] orchestrion:bullmq:Queue_add 3.55ms
[+644ms] [PUB] tracing:orchestrion:bullmq:Queue_add:end (no subscribers)
[+1089ms] [SPAN:END] bullmq.add [a1b2c3d4] error=Validation error, cannot resolve alias "inv"
```

## Files

- `packages/dd-trace/test/debug/channel-patch.js` - Main debug patch
- `packages/dd-trace/test/setup/core.js` - Loads patch when `TEST_CHANNEL_DEBUG` is set
- `integration-tests/helpers/index.js` - Loads patch for subprocess tests via `--require`

## How It Works

1. **Channel patching**: Wraps `Channel.prototype.subscribe` to log subscriptions and wrap subscriber functions
2. **Subscriber wrapping**: Wraps each subscriber to log publish events (needed because Node.js uses a native C++ fast path that bypasses JS-level publish when there are subscribers)
3. **TracingChannel hooking**: Patches `dc-polyfill`'s `tracingChannel()` to log trace operations
4. **Shimmer hooking**: Patches `datadog-shimmer`'s `wrap()`/`massWrap()` to log wraps
5. **Rewriter patching**: Patches the orchestrion rewriter to log code transforms
6. **Span lifecycle**: Subscribes to `dd-trace:span:start` and `dd-trace:span:finish` diagnostic channels
7. **Subprocess support**: Loaded via `--require` in NODE_OPTIONS for integration tests
