# Test Helpers & Environment

## createIntegrationTestSuite (Recommended)

Simplifies test boilerplate — handles `withVersions`, `agent.load/close` automatically:

```javascript
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')

const testSetup = {
  async setup(mod) {
    this.client = new mod.Client({ host: 'localhost' })
    await this.client.connect()
  },
  async teardown() {
    await this.client.close()
  }
}

createIntegrationTestSuite('mylib', 'mylib', testSetup, {}, ({ agent, it, expect }) => {
  it('should create span on query', done => {
    agent.assertSomeTraces(traces => {
      const span = traces[0][0]
      expect(span.name).to.equal('mylib.query')
      expect(span.meta.component).to.equal('mylib')
    }).then(done, done)

    testSetup.client.query('SELECT 1').catch(done)
  })
})
```

## Docker Services

| Integration Type | Service | Command |
|------------------|---------|---------|
| Redis/Memcached/Valkey | redis | `docker compose up -d redis` |
| PostgreSQL | postgres | `docker compose up -d postgres` |
| MySQL/MariaDB | mysql | `docker compose up -d mysql` |
| MongoDB | mongo | `docker compose up -d mongo` |
| Kafka | kafka | `docker compose up -d kafka` |
| RabbitMQ/AMQP | rabbitmq | `docker compose up -d rabbitmq` |
| Elasticsearch | elasticsearch | `docker compose up -d elasticsearch` |
| Bull/BullMQ/Bee-queue | redis | `docker compose up -d redis` |

Find required services for a plugin:
```bash
grep -A10 "mylib" .github/workflows/apm-integrations.yml | grep SERVICES
```

## externals.json

Located at `packages/dd-trace/test/plugins/externals.json`. Tracks subpackage dependencies needed by tests.

```json
{
  "mylib": ["mylib-subpackage", "some-peer-dep"]
}
```

**When to add entries:**
- Test fails with "Module not found" for a dependency
- Library has peer dependencies needed at runtime
- Library re-exports from subpackages

## versions/package.json

Tested packages are installed per-version to `versions/{package}@{version}/node_modules/`. Tests load via `withVersions`:

```javascript
const lib = require(`../../../versions/mylib@${version}`).get()
```

These are auto-installed based on `versions/package.json` when `yarn services` runs.

## Manual Test Pattern (withVersions + agent.load)

For when `createIntegrationTestSuite` doesn't fit:

```javascript
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  describe('mylib', () => {
    withVersions('mylib', 'mylib', version => {
      let myLib

      beforeEach(() => {
        return agent.load('mylib')
      })

      beforeEach(() => {
        myLib = require(`../../../versions/mylib@${version}`).get()
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      it('should create a span', async () => {
        const p = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.strictEqual(span.name, 'mylib.query')
        })

        myLib.query('SELECT 1')

        await p
      })
    })
  })
})
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DD_TRACE_DEBUG=true` | Enable debug logging |
| `DD_TRACE_LOG_LEVEL=info` | Set log level (trace, debug, info, warn, error) |
| `DD_TRACE_<NAME>_ENABLED=false` | Disable specific plugin |
| `DD_TRACE_DISABLED_PLUGINS=pg,redis` | Disable multiple plugins |

## ARM64 Incompatible Packages

These fail on ARM64 (M1/M2 Macs): `aerospike`, `couchbase`, `grpc`, `oracledb`

## Never Delete Tests Policy

When fixing tests, never delete test cases. Fix the underlying issue or update assertions to match new behavior.

## Test Commands Reference

```bash
# CI command (preferred) — handles yarn services automatically
PLUGINS="mylib" npm run test:plugins:ci

# Unit tests only (assumes yarn services already ran)
PLUGINS="mylib" npm run test:plugins

# Multiple plugins
PLUGINS="mylib|redis|pg" npm run test:plugins:ci

# With mocha directly
./node_modules/.bin/mocha \
  -r "packages/dd-trace/test/setup/mocha.js" \
  packages/datadog-plugin-mylib/test/index.spec.js

# Specific test
./node_modules/.bin/mocha \
  -r "packages/dd-trace/test/setup/mocha.js" \
  packages/datadog-plugin-mylib/test/index.spec.js \
  --grep "should create span"

# With Docker services
docker compose up -d redis
SERVICES="redis" PLUGINS="mylib" npm run test:plugins:ci

# ESM integration tests
yarn test:integration packages/datadog-plugin-mylib/test/integration-test/client.spec.js

# Debug output
DD_TRACE_DEBUG=true PLUGINS="mylib" npm run test:plugins:ci
```
