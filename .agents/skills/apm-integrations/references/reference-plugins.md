# Reference Plugins by Base Class

**When stuck, copy from working code.** Match by library type, not library name.

## DatabasePlugin
```
packages/datadog-plugin-pg/
packages/datadog-plugin-mysql/
packages/datadog-plugin-mongodb-core/
packages/datadog-plugin-cassandra-driver/
packages/datadog-plugin-elasticsearch/
```

## CachePlugin
```
packages/datadog-plugin-redis/
packages/datadog-plugin-memcached/
packages/datadog-plugin-ioredis/
```

## ClientPlugin
```
packages/datadog-plugin-http/
packages/datadog-plugin-fetch/
packages/datadog-plugin-undici/
packages/datadog-plugin-grpc/
```

## ServerPlugin / RouterPlugin
```
packages/datadog-plugin-express/
packages/datadog-plugin-fastify/
packages/datadog-plugin-koa/
packages/datadog-plugin-hapi/
```

## ProducerPlugin / ConsumerPlugin
```
packages/datadog-plugin-kafkajs/
packages/datadog-plugin-amqplib/
packages/datadog-plugin-google-cloud-pubsub/
```

## CompositePlugin
```
packages/datadog-plugin-kafkajs/     (producer + consumer)
packages/datadog-plugin-express/     (tracing + code origin)
packages/datadog-plugin-graphql/
```

## LogPlugin
```
packages/datadog-plugin-winston/
packages/datadog-plugin-bunyan/
packages/datadog-plugin-pino/
```

## AI/LLM Plugins
```
packages/datadog-plugin-openai/
packages/datadog-plugin-anthropic/
packages/datadog-plugin-langchain/
```

## Key Files to Study

For any plugin:

| File | Purpose |
|------|---------|
| `src/index.js` | Plugin entry, base class selection |
| `src/tracing.js` | Tracing logic (if CompositePlugin) |
| `test/index.spec.js` | Test patterns |
| `test/integration-test/` | ESM testing (if exists) |

For instrumentation:

| File | Purpose |
|------|---------|
| `datadog-instrumentations/src/<lib>.js` | Hook logic (shimmer) or hooks file (orchestrion) |
| `datadog-instrumentations/src/helpers/hooks.js` | Registration (both shimmer and orchestrion) |
| `rewriter/instrumentations/<lib>.js` | JSON config (orchestrion) |

## How to Use References

1. **Find similar plugin** — match by library type, not name
2. **Read `src/index.js`** — understand base class choice and bindStart pattern
3. **Read `test/index.spec.js`** — understand test setup and assertions
4. **Copy structure** — adapt names and ctx fields to the new library
5. **Copy test patterns** — similar libraries have similar tests

## Golden Rules

1. If production plugins work and yours doesn't → your structure is wrong
2. Match the base class to the library type
3. Copy before creating — don't reinvent patterns
4. Test patterns transfer between similar library types
