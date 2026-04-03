# Debugging with dd-debug

dd-debug is the preferred debugging tool for test failures. It provides real-time visibility into diagnostic channels and span lifecycle.

## Why dd-debug Over DD_TRACE_DEBUG

| Feature | DD_TRACE_DEBUG=true | dd-debug |
|---------|---------------------|----------|
| Channel subscribe/publish | No | Full visibility |
| Listener invocation | No | See when plugins respond |
| Span lifecycle | Limited | start/finish/tags |
| Plugin filtering | No | Filter by plugin name |
| Real-time formatted output | No | Colored, timestamped |
| Method wrapping (shimmer) | No | See what gets wrapped |

## Usage

```bash
dd-debug <plugin-name>                    # Basic
dd-debug mylib --verbose                  # Span tags, shimmer wraps
dd-debug mylib --show-data                # Data in channels (verbose)
dd-debug mylib --output-dir ./logs        # Save to file
dd-debug mylib --show-spans=false         # Channels only
dd-debug mylib --test "should create span"  # Specific test
```

## Output Symbols

| Symbol | Meaning |
|--------|---------|
| `SUBSCRIBE` | Plugin subscribed to channel |
| `PUBLISH` | Event published to channel |
| `LISTENER` | Plugin listener triggered |
| `SPAN START` | Span created (spanId, operation, service) |
| `SPAN FINISH` | Span completed |
| `SPAN TAG` | Tag added to span |
| `WRAP` | Method wrapped via shimmer |

## Quick Diagnosis Flowchart

```
Test times out?
    ↓
Run: dd-debug <plugin> --verbose
    ↓
┌─────────────────────────────────────┐
│ No PUBLISH events?                  │
│ → Instrumentation not firing        │
│ → Check hooks.js, addHook config    │
│ → Check orchestrion filePath        │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ PUBLISH but no LISTENER?            │
│ → Plugin not subscribed correctly   │
│ → Check channel name matches        │
│ → Check static prefix in plugin     │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ LISTENER but no SPAN START?         │
│ → Plugin code error                 │
│ → Check bindStart(), startSpan()    │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ SPAN but test still fails?          │
│ → Wrong tags (80% of issues!)       │
│ → Compare TAG output to assertions  │
└─────────────────────────────────────┘
```

## Test Failure Modes

### The 80/20 Rule

- **80% of failures** = Wrong/missing tags → Fix tag extraction
- **20% of failures** = Channel issues → Fix subscriptions

### Wrong Tags (Most Common)

**Symptoms**: SPAN START events appear, tests timeout (not crash)

**Common fixes**:
- Missing `component` tag → add to `meta: { component: '<name>' }`
- Wrong resource → fix extraction (`ctx.sql`, `ctx.arguments?.[0]`)
- Missing db/messaging tags → add type-specific tags

### Channel Mismatch

**Symptoms**: PUBLISH events appear, no LISTENER events follow

**Common fixes**:
- Wrong prefix in plugin (orchestrion vs shimmer vs manual)
- Typo in channel name — copy exact name from dd-debug output

### No Events At All

**Symptoms**: No PUBLISH events

**Causes**:
1. Not registered in hooks.js
2. Wrong filePath in orchestrion config
3. Method not called in test
4. Version mismatch (check semver range)

### Error Tests Failing

Errors must occur WITHIN the instrumented function scope:

```javascript
// WRONG — error before traced function
const client = await connect({ badHost: true })  // Error here
await client.query('SELECT 1')  // Never reached

// RIGHT — error during traced function
const client = await connect()
await client.query('INVALID SQL SYNTAX')  // Error here, captured
```

## Debug Checklist

1. Run dd-debug — what events appear?
2. Check PUBLISH — instrumentation working?
3. Check LISTENER — plugin subscribed?
4. Check SPAN START — tags correct?
5. Compare to test — what's mismatched?
