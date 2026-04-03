---
name: datadog-semantics
description: |
  Datadog APM semantic conventions for span naming and tagging. Use when deciding
  what to name spans, which tags to add, or mapping library operations to Datadog
  standards. Always set as many relevant tags as possible. Triggers: "span name",
  "what tags", "required tags", "optional tags", "span kind", "db.name", "db.type",
  "messaging.system", "messaging.destination", "http.method", "http.url", "http.status_code",
  "semantic convention", "operation name", "span type", "resource name", "service name",
  "peer service", "error tags", "grpc tags", "cache tags", "apm-semantic-conventions".
---

# Datadog APM Semantic Conventions

**Goal: Set as many relevant tags as possible.** Rich tags enable better filtering, dashboards, and alerting.

## Querying Semantics

### Using the Script (Recommended)

Run `scripts/get_semantics.py` to query semantic conventions:

```bash
# List all available categories
python scripts/get_semantics.py

# Get all tags for a category
python scripts/get_semantics.py database

# Get only required tags
python scripts/get_semantics.py database required

# Get only recommended tags
python scripts/get_semantics.py messaging recommended

# Dump all categories as JSON
python scripts/get_semantics.py --all
```

### Available Categories

| Category | Description |
|----------|-------------|
| `database` | SQL/NoSQL database clients |
| `messaging` | Kafka, RabbitMQ, SQS, etc. |
| `cache` | Redis, Memcached |
| `http-client` | HTTP client libraries |
| `http-server` | Web frameworks |
| `grpc-client` | gRPC clients |
| `grpc-server` | gRPC servers |
| `graphql` | GraphQL servers/clients |
| `search` | Elasticsearch, OpenSearch |
| `aws` | AWS SDK clients |
| `ai` | LLM and AI providers |

### Python API (Alternative)

```python
from apm_semantic_conventions import list_categories, get_tags_for_category

categories = list_categories()
tags = get_tags_for_category('database')
# tags has keys: 'required', 'recommended', 'conditionally_required', 'opt_in'
```

**Always query semantics** when analyzing a library to understand required vs recommended tags.

## Span Structure

| Field | Description | Example |
|-------|-------------|---------|
| **name** | Operation name | `pg.query`, `kafka.send` |
| **resource** | What's being accessed | `SELECT * FROM users`, `events-topic` |
| **service** | Service identifier | `my-app`, `my-app-postgres` |
| **type** | Span category | `sql`, `web`, `cache`, `http` |

## Span Kinds

| Kind | Use Case | Direction |
|------|----------|-----------|
| `server` | Incoming requests | Inbound |
| `client` | Outgoing requests | Outbound |
| `producer` | Message publishing | Outbound |
| `consumer` | Message processing | Inbound |
| `internal` | Internal operations | Neither |

---

## Database Semantics

### Required Tags

```
db.type          # Database system: postgres, mysql, mongodb, etc.
db.name          # Database/schema name
```

### Recommended Tags

```
db.system        # Alternative to db.type
db.user          # Database user
db.statement     # Query (truncated if long)
db.operation     # SELECT, INSERT, UPDATE, DELETE
db.row_count     # Number of rows affected/returned
out.host         # Database host
network.destination.port  # Database port
```

### Resource Naming

- **SQL databases**: Truncated query or operation type
- **NoSQL**: Operation + collection name
- Examples: `SELECT users`, `find orders`, `aggregate events`

### Service Naming

Pattern: `{app-service}-{db-system}`
Examples: `my-app-postgres`, `my-app-mongodb`

### DBM (Database Monitoring)

When enabled, inject trace context into SQL comments:
```
_dd.dbm_trace_injected   # Flag indicating injection
```

---

## Cache Semantics

### Required Tags

```
db.type          # Cache system: redis, memcached
db.name          # Database number or cache name
```

### Recommended Tags

```
redis.raw_command        # Full Redis command
memcached.command        # Memcached command
cache.hit                # true/false for get operations
out.host                 # Cache host
network.destination.port # Cache port
```

### Resource Naming

The command: `GET`, `SET`, `HGET`, `MGET`, etc.

### Service Naming

Pattern: `{app-service}-{cache-system}`
Examples: `my-app-redis`, `my-app-memcached`

---

## HTTP Client Semantics

### Required Tags

```
http.method       # GET, POST, PUT, DELETE, etc.
http.url          # Full request URL
http.status_code  # Response status code
```

### Recommended Tags

```
http.route                # Route pattern if known
http.request_content_length   # Request body size
http.response_content_length  # Response body size
http.useragent            # User-Agent header
out.host                  # Remote host
network.destination.port  # Remote port
```

### Resource Naming

Pattern: `{METHOD} {path}`
Examples: `GET /api/users`, `POST /orders`

### Peer Service

Derived from `out.host` for service topology.

---

## HTTP Server Semantics

### Required Tags

```
http.method       # Request method
http.url          # Request URL
http.status_code  # Response status
```

### Recommended Tags

```
http.route            # Route pattern: /users/:id
http.useragent        # Client User-Agent
http.client_ip        # Client IP address
http.request.headers.*   # Request headers (selective)
http.response.headers.*  # Response headers (selective)
```

### Resource Naming

Pattern: `{METHOD} {route}`
Examples: `GET /users/:id`, `POST /api/orders`

### Span Type

Always `web` for HTTP server spans.

---

## Messaging Producer Semantics

### Required Tags

```
messaging.system           # kafka, rabbitmq, sqs, etc.
messaging.destination.name # Topic or queue name
```

### Recommended Tags

```
messaging.destination.kind     # topic, queue
messaging.message.payload_size # Message size in bytes
messaging.batch.message_count  # Number of messages in batch
messaging.kafka.partition      # Kafka partition
messaging.kafka.key            # Message key
```

### Kafka-Specific

```
kafka.topic
kafka.partition
kafka.cluster_id
messaging.kafka.bootstrap.servers
```

### Resource Naming

The topic/queue name: `user-events`, `order-queue`

### Context Propagation

**Always inject trace context** into message headers for distributed tracing.

---

## Messaging Consumer Semantics

### Required Tags

```
messaging.system           # kafka, rabbitmq, sqs, etc.
messaging.destination.name # Topic or queue name
```

### Recommended Tags

```
messaging.message.payload_size  # Message size
messaging.kafka.partition       # Partition consumed from
messaging.kafka.offset          # Message offset
messaging.kafka.consumer_group  # Consumer group
messaging.operation             # receive, process
```

### Resource Naming

The topic/queue name: `user-events`, `order-queue`

### Context Propagation

**Always extract trace context** from message headers to link producer→consumer.

### Span Type

Use `worker` for background message processing.

---

## gRPC Semantics

### Required Tags

```
grpc.method.path    # Full method path: /pkg.Service/Method
grpc.method.name    # Method name: GetUser
grpc.method.service # Service name: UserService
grpc.status.code    # Status code (0=OK)
```

### Recommended Tags

```
grpc.method.package # Package name
grpc.method.kind    # unary, server_stream, client_stream, bidi_stream
grpc.request.metadata.*   # Request metadata
grpc.response.metadata.*  # Response metadata
```

### Resource Naming

The method path: `/com.example.UserService/GetUser`

### Streaming Types

| Kind | Client | Server |
|------|--------|--------|
| `unary` | 1 request | 1 response |
| `server_stream` | 1 request | N responses |
| `client_stream` | N requests | 1 response |
| `bidi_stream` | N requests | N responses |

---

## GraphQL Semantics

### Required Tags

```
graphql.operation.name  # Query/mutation name
graphql.operation.type  # query, mutation, subscription
```

### Recommended Tags

```
graphql.document        # The GraphQL document
graphql.variables       # Variables (sanitized)
graphql.field           # Field being resolved
graphql.source          # Source type for resolver
```

### Resource Naming

The operation name: `GetUser`, `CreateOrder`

---

## Error Tags

When errors occur, always set:

```
error              # true or 1
error.type         # Error class name
error.message      # Error message
error.stack        # Stack trace
```

---

## Peer Service Tags

For service topology visualization:

```
peer.service                    # Peer service name
_dd.peer.service.source         # Source tag (db.name, out.host)
_dd.peer.service.remapped_from  # Original before remapping
```

---

## Service Naming Patterns

| Category | Pattern | Example |
|----------|---------|---------|
| App service | From DD_SERVICE | `my-app` |
| Database | `{app}-{system}` | `my-app-postgres` |
| Cache | `{app}-{system}` | `my-app-redis` |
| Messaging | `{app}` or custom | `my-app` |

---

## Operation Name Patterns

| Category | Pattern | Example |
|----------|---------|---------|
| Database | `{system}.query` | `pg.query` |
| Cache | `{system}.command` | `redis.command` |
| HTTP Client | `http.request` | `http.request` |
| HTTP Server | `{framework}.request` | `express.request` |
| Producer | `{system}.send` | `kafka.send` |
| Consumer | `{system}.receive` | `kafka.receive` |
| gRPC | `grpc.{client\|server}` | `grpc.client` |

---

## Best Practices

1. **Set all applicable tags** - More tags = better observability
2. **Use standard tag names** - Don't invent new ones
3. **Truncate long values** - Queries, URLs should be bounded
4. **Match existing patterns** - Check reference integrations
5. **Read the semantics files** - They define what's required

## Common Mistakes

1. **Missing required tags** - Each category has must-have tags
2. **Wrong span kind** - Consumer is `consumer`, not `client`
3. **Inconsistent naming** - Follow `{system}.{operation}` pattern
4. **Not setting resource** - Resource enables grouping in UI
5. **Inventing tag names** - Use standard semantic tags

## Related Skills

- **What to instrument?** See `observability-patterns` skill
- **Writing plugins?** See `plugins` skill
- **Reference implementations?** See `reference-integrations` skill
