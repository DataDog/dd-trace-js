<h1 id="home">Datadog JavaScript Tracer API</h1>

This is the API documentation for the Datadog JavaScript Tracer. If you are just looking to get started, check out the [tracing setup documentation](https://docs.datadoghq.com/tracing/setup/nodejs/).

<h2 id="overview">Overview</h2>

The module exported by this library is an instance of the [Tracer](./interfaces/tracer.html) class.

<h2 id="auto-instrumentation">Automatic Instrumentation</h2>

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
<h5 id="aws-sdk"></h5>
<h5 id="aws-sdk-tags"></h5>
<h5 id="aws-sdk-config"></h5>
<h5 id="bunyan"></h5>
<h5 id="couchbase"></h5>
<h5 id="cucumber"></h5>
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
<h5 id="jest"></h5>
<h5 id="kafkajs"></h5>
<h5 id="koa"></h5>
<h5 id="koa-tags"></h5>
<h5 id="koa-config"></h5>
<h5 id="memcached"></h5>
<h5 id="memcached-tags"></h5>
<h5 id="memcached-config"></h5>
<h5 id="microgateway-core"></h5>
<h5 id="mocha"></h5>
<h5 id="moleculer"></h5>
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
<h5 id="next"></h5>
<h5 id="oracledb"></h5>
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
* [aws-sdk](./interfaces/plugins.aws_sdk.html)
* [bluebird](./interfaces/plugins.bluebird.html)
* [couchbase](./interfaces/plugins.couchbase.html)
* [cucumber](./interfaces/plugins.cucumber.html)
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
* [jest](./interfaces/plugins.jest.html)
* [kafkajs](./interfaces/plugins.kafkajs.html)
* [knex](./interfaces/plugins.knex.html)
* [koa](./interfaces/plugins.koa.html)
* [ioredis](./interfaces/plugins.ioredis.html)
* [microgateway--core](./interfaces/plugins.microgateway_core.html)
* [mocha](./interfaces/plugins.mocha.html)
* [mongodb-core](./interfaces/plugins.mongodb_core.html)
* [mysql](./interfaces/plugins.mysql.html)
* [mysql2](./interfaces/plugins.mysql2.html)
* [net](./interfaces/plugins.net.html)
* [next](./interfaces/plugins.next.html)
* [oracledb](./interfaces/plugins.oracledb.html)
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

<h2 id="manual-instrumentation">Manual Instrumentation</h2>

If you aren’t using supported library instrumentation (see [Compatibility](https://docs.datadoghq.com/tracing/setup/nodejs/#compatibility)), you may want to manually instrument your code.

This can be done using the [tracer.trace()](./interfaces/tracer.html#trace) and the [tracer.wrap()](./interfaces/tracer.html#wrap) methods which handle the span lifecycle and scope management automatically. In some rare cases the scope needs to be handled manually as well in which case the [tracer.scope()](./interfaces/tracer.html#scope) method is provided.

The different ways to use the above methods are described below.

<h3 id="tracer-trace">tracer.trace(name[, options], callback)</h3>

This method allows you to trace a specific operation at the moment it is executed. It supports synchronous and asynchronous operations depending on how it's called.

<h4 id="sync">Synchronous</h4>

To trace synchronously, simply call `tracer.trace()` without passing a function to the callback.

```javascript
function handle (err) {
  tracer.trace('web.request', span => {
    // some code
  })
}
```

If an error is thrown in the callback, it will be automatically added to the span.

<h4 id="callback">Callback</h4>

The most basic approach to trace asynchronous operations is to pass a function to the callback provided to the method.

```javascript
function handle (err) {
  tracer.trace('web.request', (span, cb) => {
    // some code
    cb(err)
  })
}
```

Errors passed to the callback will automatically be added to the span.

<h4 id="promise">Promise</h4>

For promises, the span will be finished afer the promise has been either resolved or rejected.

```javascript
function handle () {
  return tracer.trace('web.request', () => {
    return new Promise((resolve, reject) => {
      // some code
    })
  })
}
```

Any error from rejected promises will automatically be added to the span.

<h4 id="async-await">Async/await</h4>

For promises, the span lifecycle will be according to the returned promise.

```javascript
async function handle () {
  return await tracer.trace('web.request', async () => {
    // some code
  })
}
```

Any error from the awaited handler will automatically be added to the span.

<h3 id="tracer-wrap">tracer.wrap(name[, options], fn)</h3>

This method works very similarly to `tracer.trace()` except it wraps a function so that `tracer.trace()` is called automatically every time the function is called. This makes it easier to patch entire functions that have already been defined, or that are returned from code that cannot be edited easily.

```javascript
function handle () {
  // some code
}

const handleWithTrace = tracer.wrap('web.request', handle)
```

Similar to `tracer.trace()`, it handles synchronous calls, callbacks, promises and async/await. The only difference being that if the last argument of the wrapped function is a callback, the span will only be finished when that callback is called.

For example:

```javascript
function handle (a, b, c, callback) {
  // some code
  callback()
}

const handleWithTrace = tracer.wrap('web.request', handle)
```

<h3 id="scope-manager">tracer.scope()</h3>

In order to provide context propagation, this library includes a scope manager available with `tracer.scope()`. A scope is basically a wrapper around a span that can cross both synchronous and asynchronous contexts.

In most cases, it's not necessary to interact with the scope manager since `tracer.trace()` activates the span on its scope, and uses the  active span on the current scope if available as its parent. This should only be used directly for edge cases, like an internal queue of functions that are executed on a timer for example in which case the scope is lost.

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


<h2 id="opentracing-api">OpenTracing Compatibility</h2>

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

<h2 id="advanced-configuration">Advanced Configuration</h2>

<h3 id="tracer-settings">Tracer settings</h3>

Options can be configured as a parameter to the [init()](./interfaces/tracer.html#init) method or as environment variables.

| Config          | Environment Variable               | Default     | Description |
| --------------- | ---------------------------------- | ----------- | ----------- |
| -               | `DD_TRACE_ENABLED`                 | `true`         | Whether to enable dd-trace. Setting this to `false` will disable all features of the library. |
| -               | `DD_TRACE_DEBUG`                   | `false`        | Enable debug logging. |
| -               | `DD_TRACING_ENABLED`               | `true`         | Whether to enable tracing. |
| service         | `DD_SERVICE`                       | -              | The service name to be used for this program. Defaults to value of the `name` field in `package.json`. |
| version         | `DD_VERSION`                       | -              | The version number of the application. Defaults to value of the `version` field in `package.json`. |
| url             | `DD_TRACE_AGENT_URL`               | -              | The url of the trace agent that the tracer will submit to. Takes priority over hostname and port, if set. |
| hostname        | `DD_TRACE_AGENT_HOSTNAME`          | `localhost`    | The address of the agent that the tracer will submit to. |
| port            | `DD_TRACE_AGENT_PORT`              | `8126`         | The port of the trace agent that the tracer will submit to. |
| dogstatsd.port  | `DD_DOGSTATSD_PORT`                | `8125`         | The port of the Dogstatsd agent that metrics will be submitted to. |
| env             | `DD_ENV`                           | -              | Set an application’s environment e.g. `prod`, `pre-prod`, `stage`. |
| logInjection    | `DD_LOGS_INJECTION`                | `false`        | Enable automatic injection of trace IDs in logs for supported logging libraries. |
| tags            | `DD_TAGS`                          | `{}`           | Set global tags that should be applied to all spans and metrics. When passed as an environment variable, the format is `key:value,key:value` |
| sampleRate      | `DD_TRACE_SAMPLE_RATE`             | -              | Controls the ingestion sample rate (between 0 and 1) between the agent and the backend. Defaults to deferring the decision to the agent. |
| flushInterval   | -                                  | `2000`         | Interval in milliseconds at which the tracer will submit traces to the agent. |
| flushMinSpans   | `DD_TRACE_PARTIAL_FLUSH_MIN_SPANS` | `1000`         | Number of spans before partially exporting a trace. This prevents keeping all the spans in memory for very large traces. |
| lookup          | -                                  | `dns.lookup()` | Custom function for DNS lookups when sending requests to the agent. |
| protocolVersion | `DD_TRACE_AGENT_PROTOCOL_VERSION`  | `0.4`          | Protocol version to use for requests to the agent. The version configured must be supported by the agent version installed or all traces will be dropped. |
| runtimeMetrics  | `DD_RUNTIME_METRICS_EN ABLED`      | `false`        | Whether to enable capturing runtime metrics. Port 8125 (or configured with `dogstatsd.port`) must be opened on the agent for UDP. |
| profiling       | `DD_PROFILING_ENABLED`             | `false`        | Whether to enable profiling. |
| reportHostname  | `DD_TRACE_REPORT_HOSTNAME`         | `false`        | Whether to report the system's hostname for each trace. When disabled, the hostname of the agent will be used instead. |
| ingestion.sampleRate | `DD_TRACE_SAMPLE_RATE`        | `-`            | Controls the ingestion sample rate (between 0 and 1) between the agent and the backend. Defaults to deferring the decision to the agent. |
| ingestion.rateLimit  | `DD_TRACE_RATE_LIMIT`         | `-`            | Controls the ingestion rate limit between the agent and the backend. Defaults to deferring the decision to the agent. |
| experimental    | -                                  | `{}`           | Experimental features can be enabled all at once using boolean `true` or individually using key/value pairs. Please contact us to learn more about the available experimental features. |
| plugins         | -                                  | `true`         | Whether or not to enable automatic instrumentation of external libraries using the built-in plugins. |
| -               | `DD_TRACE_DISABLED_PLUGINS`        | -              | A comma-separated string of integration names automatically disabled when tracer is initialized. Environment variable only e.g. `DD_TRACE_DISABLED_PLUGINS=express,dns`. |
| logLevel        | `DD_TRACE_LOG_LEVEL`               | `debug`        | A string for the minimum log level for the tracer to use when debug logging is enabled, e.g. `'error'`, `'debug'`. |
| startupLogs     | `DD_TRACE_STARTUP_LOGS`            | `false`        | Enable tracer startup configuration and diagnostic log. |
| appsec.enabled              | `DD_APPSEC_ENABLED`                            | `false` | Enable AppSec protection. |
| appsec.rules                | `DD_APPSEC_RULES`                              | -       | A path to a custom AppSec rules file. |
| appsec.wafTimeout           | `DD_APPSEC_WAF_TIMEOUT`                        | `5000`  | Limits the WAF synchronous execution time (in microseconds). |
| appsec.obfuscatorKeyRegex   | `DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP`   | -       | A regex to redact sensitive data by its key in attack reports. |
| appsec.obfuscatorValueRegex | `DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP` | -       | A regex to redact sensitive data by its value in attack reports. |

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
    error: err => logger.error(err),
    warn: message => logger.warn(message),
    info: message => logger.info(message),
    debug: message => logger.trace(message),
  },
  debug: true
})
```

<h3 id="span-hooks">Span Hooks</h3>

In some cases, it's necessary to update the metadata of a span created by one of the built-in integrations. This is possible using span hooks registered by integration. Each hook provides the span as the first argument and other contextual objects as additional arguments.

For example:

```javascript
const tracer = require('dd-trace').init()

tracer.use('express', {
  hooks: {
    request: (span, req, res) => {
      span.setTag('customer.id', req.query.id)
    }
  }
})
```

Right now this functionality is limited to Web frameworks.

More information on which hooks are supported for each integration can be found in each individual [plugins](./modules/plugins.html).

<h3 id="set-user">User Identification</h3>

The tracer provides a convenience function to link an actor to a trace. For example to correlate users to web requests.
You have to pass an object with at least an `id` property.

For example:

```javascript
const tracer = require('dd-trace').init()

function handle () {
  tracer.setUser({
    id: '123456789', // *REQUIRED* Unique identifier of the user.
    
    // All other fields are optional.
    email: 'jane.doe@example.com', // Email of the user.
    name: 'Jane Doe', // User-friendly name of the user.
    session_id: '987654321', // Session ID of the user.
    role: 'admin', // Role the user is making the request under.
    scope: 'read:message, write:files', // Scopes or granted authorizations the user currently possesses.
    
    // Arbitrary fields are also accepted to attach custom data to the user (RBAC, Oauth, etc…)
    custom_tag: 'custom data'
  })
}
```
