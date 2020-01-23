<h1 id="home">Datadog JavaScript Tracer API</h1>

This is the API documentation for the Datadog JavaScript Tracer. If you are just looking to get started, check out the [tracing setup documentation](https://docs.datadoghq.com/tracing/setup/nodejs/).

<h2 id="overview">Overview</h2>

The module exported by this library is an instance of the [Tracer](./interfaces/tracer.html) class.

<h2 id="manual-instrumentation">Manual Instrumentation</h2>

If you aren’t using supported library instrumentation (see [Compatibility](https://docs.datadoghq.com/tracing/setup/nodejs/#compatibility)), you may want to manually instrument your code.

This can be done using the [OpenTracing API](#opentracing-api) and the [Scope Manager](#scope-manager).

<h3 id="opentracing-api">OpenTracing API</h3>

This library is OpenTracing compliant. Use the [OpenTracing API](https://doc.esdoc.org/github.com/opentracing/opentracing-javascript/) and the Datadog Tracer (dd-trace) library to measure execution times for specific pieces of code. In the following example, a Datadog Tracer is initialized and used as a global tracer:

```javascript
const tracer = require('dd-trace').init()
const opentracing = require('opentracing')

opentracing.initGlobalTracer(tracer)
```

The following tags are available to override Datadog specific options:

* `service.name`: The service name to be used for this span. The service name from the tracer will be used if this is not provided.
* `resource.name`: The resource name to be used for this span. The operation name will be used if this is not provided.
* `span.type`: The span type to be used for this span. Will fallback to `custom` if not provided.

<h3 id="scope-manager">Scope Manager</h3>

In order to provide context propagation, this library includes a scope manager.
A scope is basically a wrapper around a span that can cross both synchronous and
asynchronous contexts.

The scope manager contains 3 APIs available on `tracer.scope()`:

<h4>scope.active()</h4>

This method returns the active span from the current scope.

<h4>scope.activate(span, fn)</h4>

This method activates the provided span in a new scope available in the
provided function. Any asynchronous context created from whithin that function
will also have the same scope.

```javascript
const tracer = require('dd-trace').init()
const scope = tracer.scope()
const log = console.log

const requestSpan = tracer.startSpan('web.request')
const promise = Promise.resolve()

scope.activate(requestSpan, () => {
  log(scope.active()) // requestSpan because in new scope

  someFunction() // requestSpan because called in scope

  setTimeout(() => {
    log(scope.active()) // requestSpan because setTimeout called in scope
  })

  promise.then(() => {
    log(scope.active()) // requestSpan because then() called in scope
  })
})

function someFunction () {
  log(scope.active())
}

log(scope.active()) // null

someFunction() // null because called outside the scope
```

<h4>scope.bind(target, [span])</h4>

This method binds a target to the specified span, or to the active span if
unspecified. It supports binding functions, promises and event emitters.

When a span is provided, the target is always bound to that span. Explicitly
passing `null` as the span will actually bind to `null` or no span. When a span
is not provided, the binding uses the following rules:

* Functions are bound to the span that is active when `scope.bind(fn)` is called.
* Promise handlers are bound to the active span in the scope where `.then()` was
called. This also applies to any equivalent method such as `.catch()`.
* Event emitter listeners are bound to the active span in the scope where
`.addEventListener()` was called. This also applies to any equivalent method
such as `.on()`

**Note**: Native promises and promises from `bluebird`, `q` and `when` are
already bound by default and don't need to be explicitly bound.

<h5>Examples</h5>

<h6>Function binding</h6>

```javascript
const tracer = require('dd-trace').init()
const scope = tracer.scope()
const log = console.log

const outerSpan = tracer.startSpan('web.request')

scope.activate(outerSpan, () => {
  const innerSpan = tracer.startSpan('web.middleware')

  const boundToInner = scope.bind(() => {
    log(scope.active())
  }, innerSpan)

  const boundToOuter = scope.bind(() => {
    log(scope.active())
  })

  boundToInner() // innerSpan because explicitly bound
  boundToOuter() // outerSpan because implicitly bound
})
```

<h6>Promise binding</h6>

```javascript
const tracer = require('dd-trace').init()
const scope = tracer.scope()
const log = console.log

const outerSpan = tracer.startSpan('web.request')
const innerPromise = Promise.resolve()
const outerPromise = Promise.resolve()

scope.activate(outerSpan, () => {
  const innerSpan = tracer.startSpan('web.middleware')

  scope.bind(innerPromise, innerSpan)
  scope.bind(outerPromise)

  innerPromise.then(() => {
    log(scope.active()) // innerSpan because explicitly bound
  })

  outerPromise.then(() => {
    log(scope.active()) // outerSpan because implicitly bound on `then()` call
  })
})
```

**Note**: `async/await` cannot be bound and always execute in the scope where
`await` was called. If binding `async/await` is needed, the promise must be
wrapped by a function.

<h6>Event emitter binding</h6>

```javascript
const tracer = require('dd-trace').init()
const scope = tracer.scope()
const log = console.log
const EventEmitter = require('events').EventEmitter

const outerSpan = tracer.startSpan('web.request')
const innerEmitter = new EventEmitter()
const outerEmitter = new EventEmitter()

scope.activate(outerSpan, async () => {
  const innerSpan = tracer.startSpan('web.middleware')

  scope.bind(innerEmitter, innerSpan)
  scope.bind(outerEmitter)

  innerEmitter.on('request', () => {
    log(scope.active()) // innerSpan because explicitly bound
  })

  outerEmitter.on('request', () => {
    log(scope.active()) // outerSpan because implicitly bound on `then()` call
  })
})

innerEmitter.emit('request')
outerEmitter.emit('request')
```

See the [API documentation](./interfaces/scope.html) for more details.

<h2 id="integrations">Integrations</h2>

APM provides out-of-the-box instrumentation for many popular frameworks and libraries by using a plugin system. By default all built-in plugins are enabled. Disabling plugins can cause unexpected side effects, so it is highly recommended to leave them enabled.

Built-in plugins can be configured individually:

```javascript
const tracer = require('dd-trace').init()

// enable and configure postgresql integration
tracer.use('pg', {
  service: 'pg-cluster'
})
```

<h5 id="amqplib"></h5>
<h5 id="amqplib-tags"></h5>
<h5 id="amqplib-config"></h5>
<h5 id="bunyan"></h5>
<h5 id="couchbase"></h5>
<h5 id="dns"></h5>
<h5 id="elasticsearch"></h5>
<h5 id="elasticsearch-tags"></h5>
<h5 id="elasticsearch-config"></h5>
<h5 id="express"></h5>
<h5 id="express-tags"></h5>
<h5 id="express-config"></h5>
<h5 id="generic-pool"></h5>
<h5 id="google-cloud-pubsub"></h5>
<h5 id="fastify"></h5>
<h5 id="fs"></h5>
<h5 id="graphql"></h5>
<h5 id="graphql-tags"></h5>
<h5 id="graphql-config"></h5>
<h5 id="grpc"></h5>
<h5 id="hapi"></h5>
<h5 id="hapi-tags"></h5>
<h5 id="hapi-config"></h5>
<h5 id="http"></h5>
<h5 id="http-tags"></h5>
<h5 id="http-config"></h5>
<h5 id="ioredis"></h5>
<h5 id="ioredis-tags"></h5>
<h5 id="ioredis-config"></h5>
<h5 id="koa"></h5>
<h5 id="koa-tags"></h5>
<h5 id="koa-config"></h5>
<h5 id="limitd-client"></h5>
<h5 id="memcached"></h5>
<h5 id="memcached-tags"></h5>
<h5 id="memcached-config"></h5>
<h5 id="mongodb-core"></h5>
<h5 id="mongodb-core-tags"></h5>
<h5 id="mongodb-core-config"></h5>
<h5 id="mysql"></h5>
<h5 id="mysql-tags"></h5>
<h5 id="mysql-config"></h5>
<h5 id="mysql2"></h5>
<h5 id="mysql2-tags"></h5>
<h5 id="mysql2-config"></h5>
<h5 id="net"></h5>
<h5 id="paperplane"></h5>
<h5 id="paperplane-tags"></h5>
<h5 id="paperplane-config"></h5>
<h5 id="pino"></h5>
<h5 id="pg"></h5>
<h5 id="pg-tags"></h5>
<h5 id="pg-config"></h5>
<h5 id="redis"></h5>
<h5 id="redis-tags"></h5>
<h5 id="redis-config"></h5>
<h5 id="restify"></h5>
<h5 id="restify-tags"></h5>
<h5 id="restify-config"></h5>
<h5 id="tedious"></h5>
<h5 id="when"></h5>
<h5 id="winston"></h5>
<h3 id="integrations-list">Available Plugins</h3>

* [amqp10](./interfaces/plugins.amqp10.html)
* [amqplib](./interfaces/plugins.amqplib.html)
* [bluebird](./interfaces/plugins.bluebird.html)
* [couchbase](./interfaces/plugins.couchbase.html)
* [bunyan](./interfaces/plugins.bunyan.html)
* [cassandra-driver](./interfaces/plugins.cassandra_driver.html)
* [connect](./interfaces/plugins.connect.html)
* [dns](./interfaces/plugins.dns.html)
* [elasticsearch](./interfaces/plugins.elasticsearch.html)
* [express](./interfaces/plugins.express.html)
* [fastify](./interfaces/plugins.fastify.html)
* [fs](./interfaces/plugins.fs.html)
* [generic-pool](./interfaces/plugins.generic_pool.html)
* [google-cloud-pubsub](./interfaces/plugins.google_cloud_pubsub.html)
* [graphql](./interfaces/plugins.graphql.html)
* [grpc](./interfaces/plugins.grpc.html)
* [hapi](./interfaces/plugins.hapi.html)
* [http](./interfaces/plugins.http.html)
* [http2](./interfaces/plugins.http2.html)
* [ioredis](./interfaces/plugins.ioredis.html)
* [knex](./interfaces/plugins.knex.html)
* [koa](./interfaces/plugins.koa.html)
* [limitd-client](./interfaces/plugins.limitd_client.html)
* [ioredis](./interfaces/plugins.ioredis.html)
* [mongodb-core](./interfaces/plugins.mongodb_core.html)
* [mysql](./interfaces/plugins.mysql.html)
* [mysql2](./interfaces/plugins.mysql2.html)
* [net](./interfaces/plugins.net.html)
* [paperplane](./interfaces/plugins.paperplane.html)
* [pino](./interfaces/plugins.pino.html)
* [pg](./interfaces/plugins.pg.html)
* [promise](./interfaces/plugins.promise.html)
* [promise-js](./interfaces/plugins.promise_js.html)
* [q](./interfaces/plugins.q.html)
* [redis](./interfaces/plugins.redis.html)
* [restify](./interfaces/plugins.restify.html)
* [router](./interfaces/plugins.router.html)
* [tedious](./interfaces/plugins.tedious.html)
* [when](./interfaces/plugins.when.html)
* [winston](./interfaces/plugins.winston.html)

<h2 id="advanced-configuration">Advanced Configuration</h2>

<h3 id="tracer-settings">Tracer settings</h3>

Options can be configured as a parameter to the [init()](./interfaces/tracer.html#init) method or as environment variables.

| Config         | Environment Variable           | Default     | Description |
| -------------- | ------------------------------ | ----------- | ----------- |
| enabled        | `DD_TRACE_ENABLED`             | `true`      | Whether to enable the tracer. |
| debug          | `DD_TRACE_DEBUG`               | `false`     | Enable debug logging in the tracer. |
| service        | `DD_SERVICE_NAME`              | -           | The service name to be used for this program. |
| url            | `DD_TRACE_AGENT_URL`           | -           | The url of the trace agent that the tracer will submit to. Takes priority over hostname and port, if set. |
| hostname       | `DD_TRACE_AGENT_HOSTNAME`      | `localhost` | The address of the agent that the tracer will submit to. |
| port           | `DD_TRACE_AGENT_PORT`          | `8126`      | The port of the trace agent that the tracer will submit to. |
| dogstatsd.port | `DD_DOGSTATSD_PORT`            | `8125`      | The port of the Dogstatsd agent that metrics will be submitted to. |
| env            | `DD_ENV`                       | -           | Set an application’s environment e.g. `prod`, `pre-prod`, `stage`. |
| logInjection   | `DD_LOGS_INJECTION`            | `false`     | Enable automatic injection of trace IDs in logs for supported logging libraries. |
| tags           | `DD_TAGS`                      | `{}`        | Set global tags that should be applied to all spans and metrics. When passed as an environment variable, the format is `key:value,key:value` |
| sampleRate     | -                              | `1`         | Percentage of spans to sample as a float between 0 and 1. |
| flushInterval  | -                              | `2000`      | Interval in milliseconds at which the tracer will submit traces to the agent. |
| runtimeMetrics | `DD_RUNTIME_METRICS_ENABLED`   | `false`     | Whether to enable capturing runtime metrics. Port 8125 (or configured with `dogstatsd.port`) must be opened on the agent for UDP. |
| reportHostname | `DD_TRACE_REPORT_HOSTNAME`     | `false`     | Whether to report the system's hostname for each trace. When disabled, the hostname of the agent will be used instead. |
| experimental   | -                              | `{}`        | Experimental features can be enabled all at once using boolean `true` or individually using key/value pairs. Please contact us to learn more about the available experimental features. |
| plugins        | -                              | `true`      | Whether or not to enable automatic instrumentation of external libraries using the built-in plugins. |
| -              | `DD_TRACE_DISABLED_PLUGINS`    | -           | A comma-separated string of integration names automatically disabled when tracer is initialized. Environment variable only e.g. `DD_TRACE_DISABLED_PLUGINS=express,dns`. |
| clientToken    | `DD_CLIENT_TOKEN`              | -           | Client token for browser tracing. Can be generated in the UI at `Integrations -> APIs`. |
| logLevel       | `DD_TRACE_LOG_LEVEL`           | `debug`     | A string for the minimum log level for the tracer to use when debug logging is enabled, e.g. `'error'`, `'debug'`. |

<h3 id="custom-logging">Custom Logging</h3>

By default, logging from this library is disabled. In order to get debugging information and errors sent to logs, the `debug` options should be set to `true` in the [init()](./interfaces/tracer.html#init) method.

The tracer will then log debug information to `console.log()` and errors to `console.error()`. This behavior can be changed by passing a custom logger to the tracer. The logger should contain a `debug()` and `error()` methods that can handle messages and errors, respectively.

For example:

```javascript
const bunyan = require('bunyan')
const logger = bunyan.createLogger({
  name: 'dd-trace',
  level: 'trace'
})

const tracer = require('dd-trace').init({
  logger: {
    debug: message => logger.trace(message),
    error: err => logger.error(err)
  },
  debug: true
})
```
