# Integration Patterns by Category

## Table of Contents

1. [Database Clients](#database-clients)
2. [Cache Systems](#cache-systems)
3. [HTTP Clients](#http-clients)
4. [HTTP Servers / Web Frameworks](#http-servers--web-frameworks)
5. [Messaging - Producers](#messaging---producers)
6. [Messaging - Consumers](#messaging---consumers)
7. [Job Queues / Background Workers](#job-queues--background-workers)
8. [LLM / AI APIs](#llm--ai-apis)
9. [AI Agents](#ai-agents)
10. [Streaming Responses](#streaming-responses)
11. [Logging Libraries](#logging-libraries)
12. [Testing Frameworks](#testing-frameworks)
13. [ORM / Query Builders](#orm--query-builders)
14. [GraphQL](#graphql)
15. [gRPC](#grpc)

---

## Database Clients

### What to Trace
- Query execution (`query()`, `execute()`, `find()`)
- Transaction boundaries (begin, commit, rollback)
- Batch operations

### What to Skip
- Connection pooling
- Query builders (without execution)
- Result parsing
- Schema introspection

### Hook Strategy
**Hook the method that sends the query over the network.**

```
client.query('SELECT * FROM users')    → Wrap this
queryBuilder.select('*').from('users') → Don't wrap, no I/O
```

The query builder creates an object. The execute method does the work.

---

## Cache Systems

### What to Trace
- Get, set, delete operations
- Batch operations (mget, mset)
- Pub/sub operations

### What to Skip
- Connection management
- Key generation helpers
- Serialization

### Hook Strategy
**Hook command methods directly.** Cache APIs are typically simple.

```
redis.get(key)     → Wrap
redis.set(key, v)  → Wrap
redis.mget(keys)   → Wrap
```

---

## HTTP Clients

### What to Trace
- Request execution
- Each request in batch operations

### What to Skip
- Client instantiation
- Request builders
- Retry internals (track via tags)

### Hook Strategy
**One span per HTTP request.**

```
http.request(url)  → Wrap
fetch(url)         → Wrap
axios.get(url)     → Wrap
```

---

## HTTP Servers / Web Frameworks

### What to Trace
- Request handling (the per-request work)
- Middleware execution
- Route dispatch

### What to Skip
- `app.listen()`, `app.use()`, `app.get()` - Setup methods
- Route registration
- Server configuration

### Hook Strategy
**DO NOT hook public registration APIs.** They run once at startup.
**DO hook internal methods called per-request.**

```
// WRONG - runs once at startup
app.get('/users', handler)  → Don't wrap

// RIGHT - runs per request
internalRouter.handle(req, res)  → Wrap this
server._handleRequest(req)       → Or this
```

### Finding the Right Method
Look for:
- `server.on('request', ...)` handler internals
- Middleware chain execution
- Route matching + handler invocation

---

## Messaging - Producers

### What to Trace
- Send/publish methods
- Batch send operations

### What to Skip
- Connection setup
- Queue/topic creation
- Producer configuration

### Hook Strategy
**Hook the send method.** Also inject trace context.

```
producer.send(message)    → Wrap
publisher.publish(msg)    → Wrap

// Inside wrapper: inject trace context
inject(span, message.headers)
```

---

## Messaging - Consumers

### What to Trace
- **Handler invocation** - when library calls user's callback
- Each message processed

### What to Skip
- Consumer registration - `on('message', handler)`
- Group management
- Subscription setup

### Hook Strategy
**Critical: Hook invocation, not registration.**

```
// WRONG - just stores handler
consumer.on('message', handler)  → Don't wrap

// RIGHT - where handler is called
consumer._processMessage(msg)    → Wrap this
consumer._invokeHandler(msg)     → Or this
```

### Finding the Right Method
Search library source for where it:
- Iterates over messages
- Calls the user's callback/handler
- Processes incoming messages

---

## Job Queues / Background Workers

### What to Trace
- Job addition (producer pattern)
- Job processing (consumer pattern)

### What to Skip
- Worker setup
- Queue configuration
- Internal scheduling

### Hook Strategy
Same as messaging:
- **Add job**: Hook the add/push method
- **Process job**: Hook the internal processor invocation

```
queue.add(job)              → Wrap (producer)
worker.process(handler)     → Don't wrap (registration)
worker._processJob(job)     → Wrap (invocation)
```

---

## LLM / AI APIs

### What to Trace
- API calls (completions, chat, embeddings)
- Model invocations

### What to Skip
- Client instantiation
- Prompt building
- Response parsing utilities

### Hook Strategy
**Hook the API call methods.** Handle streaming specially.

```
openai.chat.completions.create()  → Wrap
anthropic.messages.create()       → Wrap
```

### Streaming
1. Hook stream creation
2. Track chunks as they arrive
3. Finalize span when stream completes

---

## AI Agents

### What to Trace
- Agent execution runs
- Individual steps/iterations
- Tool/function calls
- Chain executions

### What to Skip
- Agent configuration
- Tool registration
- Memory setup

### Hook Strategy
Create span hierarchy:

```
agent.run()           → Parent span
├── agent._step()     → Child spans
│   └── tool.call()   → Grandchild spans
└── agent._step()
```

**Hook both the run method and internal step execution.**

---

## Streaming Responses

Applies to: LLM, HTTP, gRPC streams, database cursors

### What to Trace
- Stream start
- Stream completion
- Optionally: chunk events

### What to Skip
- Buffer management
- Internal plumbing

### Hook Strategy
**Span lifecycle must match stream lifecycle.**

```
stream = createStream()    → Start span
stream.on('data', ...)     → Accumulate data
stream.on('end', ...)      → Finish span
stream.on('error', ...)    → Finish with error
```

Collect data during streaming, set final tags on completion.

---

## Logging Libraries

### What to Trace
- Log emission - inject trace context

### What to Skip
- Logger creation
- Level configuration
- Transport setup

### Hook Strategy
**Hook log methods to inject trace IDs.**

```
logger.info(message)   → Wrap to inject trace context
logger.error(message)  → Wrap to inject trace context
```

---

## Testing Frameworks

### What to Trace
- Test session start/end
- Test suite execution
- Individual test execution

### What to Skip
- Test registration
- Framework configuration
- Fixture setup

### Hook Strategy
**Hook lifecycle methods**, not test definition.

```
describe('suite', () => {...})  → Don't wrap
it('test', () => {...})         → Don't wrap

runner.runSuite(suite)    → Wrap
runner.runTest(test)      → Wrap
```

---

## ORM / Query Builders

### What to Trace
- Query execution (when it hits the database)
- Transaction boundaries

### What to Skip
- Model definition
- Migrations
- Query building

### Hook Strategy
**Find where the ORM calls the underlying database driver.**

```
User.findAll({...})        → Don't wrap (builds query)
connection.query(sql)      → Wrap (sends query)
```

---

## GraphQL

### What to Trace
- Execute phase
- Resolve phase (depth-limited)
- Parse/validate (optional)

### What to Skip
- Schema building
- Type definitions
- Resolver registration

### Hook Strategy
**Hook execution functions**, not schema definition.

```
schema.addResolver(...)         → Don't wrap
graphql.execute(schema, query)  → Wrap
resolver.resolve(parent, args)  → Wrap (with depth limit)
```

---

## gRPC

### What to Trace
- RPC calls (client and server)
- Streaming operations

### What to Skip
- Channel setup
- Service definition
- Proto loading

### Hook Strategy
**Hook call methods for client, handler invocation for server.**

```
// Client
client.unaryCall(request)     → Wrap
client.serverStream(request)  → Wrap

// Server - NOT registration
server.addService(service)    → Don't wrap

// Server - handler invocation
server._handleCall(call)      → Wrap
```
