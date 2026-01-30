# Channel Debug Patch

A debugging tool for dd-trace-js tests that logs diagnostic channel events, span lifecycle, shimmer wraps, and code rewrites.

## Quick Start

```bash
# Enable debug logging for all tests
DD_CHANNEL_DEBUG=true PLUGINS=express yarn test:plugins

# Filter to specific patterns (supports wildcards)
DD_CHANNEL_DEBUG=true DD_CHANNEL_FILTER="*bullmq*" PLUGINS=bullmq yarn test:plugins

# Show channel message data
DD_CHANNEL_DEBUG=true DD_CHANNEL_SHOW_DATA=true PLUGINS=http yarn test:plugins
```

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DD_CHANNEL_DEBUG` | Enable debug logging | `true` |
| `DD_CHANNEL_FILTER` | Filter pattern (supports `*` wildcards) | `*bullmq*`, `apm:express*`, `*:start` |
| `DD_CHANNEL_SHOW_DATA` | Show channel message payloads | `true` |
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

### `[RUN]` - Channel runStores
Logged when `channel.runStores()` is called, with execution time.
```
[+234ms] [RUN] apm:express:middleware:start 0.45ms
```

### `[TRACEPROMISE]` / `[TRACESYNC]` / `[TRACECALLBACK]` - TracingChannel
Logged when tracing channel methods are called.
```
[+621ms] [TRACEPROMISE] orchestrion:bullmq:Queue_add 3.55ms
```

### `[WRAP]` - Shimmer Wrap
Logged when shimmer wraps a function.
```
[+312ms] [WRAP] Router.use
```

### `[REWRITE]` - Code Rewrite
Logged when the orchestrion-style rewriter transforms code.
```
[+511ms] [REWRITE] bullmq Queue.add tracePromise dist/cjs/classes/queue.js
[+520ms] [REWRITE] bullmq Worker.callProcessJob tracePromise dist/esm/classes/worker.js
```
Format: `[REWRITE] <module> <Class.method> <operator> <filePath>`

### `[SPAN:START]` / `[SPAN:END]` - Span Lifecycle
Logged when spans are created and finished.
```
[+592ms] [SPAN:START] bullmq.add service=test-bullmq resource=test-queue
[+601ms] [SPAN:END] bullmq.add
[+605ms] [SPAN:END] bullmq.processJob error=Connection refused
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
- Channel names for SUB/PUB/RUN events
- TracingChannel names
- Module/method names for WRAP events
- Module/target names for REWRITE events
- Span names for SPAN events

## Output to File

When stderr is redirected to a file, colors are automatically disabled:

```bash
# Both stdout and stderr to file
DD_CHANNEL_DEBUG=true PLUGINS=bullmq yarn test:plugins &>/tmp/debug.txt

# See output live AND save to file
DD_CHANNEL_DEBUG=true PLUGINS=bullmq yarn test:plugins 2>&1 | tee /tmp/debug.txt

# Force no colors even in terminal
NO_COLOR=1 DD_CHANNEL_DEBUG=true PLUGINS=bullmq yarn test:plugins
```

## Example Output

```
[channel-debug] Filter: *bullmq*
[+274ms] [REWRITE] bullmq FlowProducer.add tracePromise dist/cjs/classes/flow-producer.js
[+286ms] [REWRITE] bullmq Queue.add tracePromise dist/cjs/classes/queue.js
[+286ms] [REWRITE] bullmq Queue.addBulk tracePromise dist/cjs/classes/queue.js
[+294ms] [REWRITE] bullmq Worker.callProcessJob tracePromise dist/cjs/classes/worker.js
[+493ms] [SUB] tracing:orchestrion:bullmq:Queue_add:start ← anon
[+493ms] [SUB] tracing:orchestrion:bullmq:Queue_add:asyncEnd ← anon
[+493ms] [SUB] tracing:orchestrion:bullmq:Queue_add:error ← anon
[+493ms] [SUB] tracing:orchestrion:bullmq:Queue_add:finish ← anon
[+592ms] [SPAN:START] bullmq.add service=test-bullmq resource=test-queue
[+601ms] [SPAN:END] bullmq.add
[+605ms] [SPAN:START] bullmq.processJob service=test-bullmq resource=test-queue
[+605ms] [SPAN:END] bullmq.processJob
[+621ms] [TRACEPROMISE] orchestrion:bullmq:Queue_add 3.55ms
[+644ms] [PUB] tracing:orchestrion:bullmq:Queue_add:end (no subscribers)
[+1089ms] [SPAN:END] bullmq.add error=Validation error, cannot resolve alias "inv"
```

## Files

- `packages/dd-trace/test/debug/channel-patch.js` - Main debug patch
- `packages/dd-trace/test/debug/channel-patch.mjs` - ESM wrapper
- `packages/dd-trace/test/setup/core.js` - Loads patch when `DD_CHANNEL_DEBUG` is set
- `integration-tests/helpers/index.js` - Loads patch for ESM subprocess tests

## How It Works

1. **Channel patching**: Patches `diagnostics_channel.Channel.prototype` to log subscribe/publish/runStores
2. **TracingChannel hooking**: Uses ritm to hook `dc-polyfill` and patch `tracingChannel()`
3. **Shimmer hooking**: Uses ritm to hook `shimmer`/`datadog-shimmer` and patch `wrap()`/`massWrap()`
4. **Rewriter patching**: Patches the orchestrion rewriter to log code transforms
5. **Span patching**: Patches `tracer.startSpan()` and `span.finish()` via test agent integration
6. **ESM support**: Loaded via `--require` in subprocess NODE_OPTIONS
