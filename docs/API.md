<h1 id="home">Datadog JavaScript Tracer API</h1>

This is the API documentation for the Datadog JavaScript Tracer. If you are just looking to get started, check out the [tracing setup documentation](https://docs.datadoghq.com/tracing/setup/nodejs/).

<h2 id="overview">Overview</h2>

The module exported by this library is an instance of the [Tracer](./interfaces/tracer.html) class.

<h2 id="auto-instrumentation">Automatic Instrumentation</h2>

APM provides out-of-the-box instrumentation for many popular frameworks and libraries by using a plugin system. By default, all built-in plugins are enabled. Disabling plugins can cause unexpected side effects, so it is highly recommended to leave them enabled.

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
<h5 id="avsc"></h5>
<h5 id="aws-sdk"></h5>
<h5 id="aws-sdk-tags"></h5>
<h5 id="aws-sdk-config"></h5>
<h5 id="azure-functions"></h5>
<h5 id="bunyan"></h5>
<h5 id="confluentinc-kafka-javascript"></h5>
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
<h5 id="fetch"></h5>
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
<h5 id="iovalkey"></h5>
<h5 id="iovalkey-tags"></h5>
<h5 id="iovalkey-config"></h5>
<h5 id="jest"></h5>
<h5 id="kafkajs"></h5>
<h5 id="koa"></h5>
<h5 id="koa-tags"></h5>
<h5 id="koa-config"></h5>
<h5 id="ldapjs"></h5>
<h5 id="mariadb"></h5>
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
<h5 id="opensearch"></h5>
<h5 id="oracledb"></h5>
<h5 id="pino"></h5>
<h5 id="pg"></h5>
<h5 id="pg-tags"></h5>
<h5 id="pg-config"></h5>
<h5 id="prisma"></h5>
<h5 id="protobufjs"></h5>
<h5 id="redis"></h5>
<h5 id="redis-tags"></h5>
<h5 id="redis-config"></h5>
<h5 id="restify"></h5>
<h5 id="restify-tags"></h5>
<h5 id="restify-config"></h5>
<h5 id="tedious"></h5>
<h5 id="undici"></h5>
<h5 id="when"></h5>
<h5 id="winston"></h5>
<h3 id="integrations-list">Available Plugins</h3>

* [amqp10](./interfaces/export_.plugins.amqp10.html)
* [amqplib](./interfaces/export_.plugins.amqplib.html)
* [avsc](./interfaces/export_.plugins.avsc.html)
* [aws-sdk](./interfaces/export_.plugins.aws_sdk.html)
* [azure-functions](./interfaces/export_.plugins.azure_functions.html)
* [bluebird](./interfaces/export_.plugins.bluebird.html)
* [couchbase](./interfaces/export_.plugins.couchbase.html)
* [cucumber](./interfaces/export_.plugins.cucumber.html)
* [bunyan](./interfaces/export_.plugins.bunyan.html)
* [confluentinc-kafka-javascript](./interfaces/export_.plugins.confluentinc_kafka_javascript.html)
* [cassandra-driver](./interfaces/export_.plugins.cassandra_driver.html)
* [connect](./interfaces/export_.plugins.connect.html)
* [dns](./interfaces/export_.plugins.dns.html)
* [elasticsearch](./interfaces/export_.plugins.elasticsearch.html)
* [express](./interfaces/export_.plugins.express.html)
* [fastify](./interfaces/export_.plugins.fastify.html)
* [fetch](./interfaces/export_.plugins.fetch.html)
* [generic-pool](./interfaces/export_.plugins.generic_pool.html)
* [google-cloud-pubsub](./interfaces/export_.plugins.google_cloud_pubsub.html)
* [graphql](./interfaces/export_.plugins.graphql.html)
* [grpc](./interfaces/export_.plugins.grpc.html)
* [hapi](./interfaces/export_.plugins.hapi.html)
* [http](./interfaces/export_.plugins.http.html)
* [http2](./interfaces/export_.plugins.http2.html)
* [ioredis](./interfaces/export_.plugins.ioredis.html)
* [iovalkey](./interfaces/export_.plugins.iovalkey.html)
* [jest](./interfaces/export_.plugins.jest.html)
* [kafkajs](./interfaces/export_.plugins.kafkajs.html)
* [knex](./interfaces/export_.plugins.knex.html)
* [koa](./interfaces/export_.plugins.koa.html)
* [ldapjs](./interfaces/export_.plugins.ldapjs.html)
* [mariadb](./interfaces/export_.plugins.mariadb.html)
* [microgateway--core](./interfaces/export_.plugins.microgateway_core.html)
* [mocha](./interfaces/export_.plugins.mocha.html)
* [mongodb-core](./interfaces/export_.plugins.mongodb_core.html)
* [mysql](./interfaces/export_.plugins.mysql.html)
* [mysql2](./interfaces/export_.plugins.mysql2.html)
* [net](./interfaces/export_.plugins.net.html)
* [next](./interfaces/export_.plugins.next.html)
* [opensearch](./interfaces/export_.plugins.opensearch.html)
* [openai](./interfaces/export_.plugins.openai.html)
* [oracledb](./interfaces/export_.plugins.oracledb.html)
* [pino](./interfaces/export_.plugins.pino.html)
* [pg](./interfaces/export_.plugins.pg.html)
* [primsa](./interfaces/export_.plugins.prisma.html)
* [promise](./interfaces/export_.plugins.promise.html)
* [promise-js](./interfaces/export_.plugins.promise_js.html)
* [protobufjs](./interfaces/export_.plugins.protobufjs.html)
* [q](./interfaces/export_.plugins.q.html)
* [redis](./interfaces/export_.plugins.redis.html)
* [restify](./interfaces/export_.plugins.restify.html)
* [router](./interfaces/export_.plugins.router.html)
* [tedious](./interfaces/export_.plugins.tedious.html)
* [undici](./interfaces/export_.plugins.undici.html)
* [when](./interfaces/export_.plugins.when.html)
* [winston](./interfaces/export_.plugins.winston.html)

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

For promises, the span will be finished after the promise has been either resolved or rejected.

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
provided function. Any asynchronous context created from within that function
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

This method binds a function to the specified span, or to the active span if
unspecified.

When a span is provided, the function is always bound to that span. Explicitly
passing `null` as the span will actually bind to `null` or no span. When a span
is not provided, the function is bound to the span that is active when
`scope.bind(fn)` is called.

<h5>Example</h5>

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

See the [API documentation](./interfaces/scope.html) for more details.

<h2 id="opentracing-api">OpenTracing Compatibility</h2>

This library is OpenTracing compliant. Use the [OpenTracing API](https://doc.esdoc.org/github.com/opentracing/opentracing-javascript/) and the Datadog Tracer (dd-trace) library to measure execution times for specific pieces of code. In the following example, a Datadog Tracer is initialized and used as a global tracer:

```javascript
const tracer = require('dd-trace').init()
const opentracing = require('opentracing')

opentracing.initGlobalTracer(tracer)
```

The following tags are available to override Datadog-specific options:

* `service.name`: The service name to be used for this span. The service name from the tracer will be used if this is not provided.
* `resource.name`: The resource name to be used for this span. The operation name will be used if this is not provided.
* `span.type`: The span type to be used for this span. Will fallback to `custom` if not provided.

<h2 id="opentelemetry-api">OpenTelemetry Compatibility</h2>

This library is OpenTelemetry compliant. Use the [OpenTelemetry API](https://opentelemetry.io/docs/instrumentation/js/) and the Datadog Tracer (dd-trace) library to measure execution times for specific pieces of code. In the following example, a Datadog TracerProvider is registered with @opentelemetry/api:

```javascript
const tracer = require('dd-trace').init()

const tracerProvider = new tracer.TracerProvider()
tracerProvider.register()
```

The following attributes are available to override Datadog-specific options:

* `service.name`: The service name to be used for this span. The service name from the tracer will be used if this is not provided.
* `resource.name`: The resource name to be used for this span. The operation name will be used if this is not provided.
* `span.type`: The span type to be used for this span. Will fallback to `custom` if not provided.

<h2 id="advanced-configuration">Advanced Configuration</h2>

<h3 id="tracer-settings">Tracer settings</h3>

Options can be configured as a parameter to the [init()](./interfaces/tracer.html#init) method or as environment variables. These are documented over on [Configuring the Node.js Tracing Library](https://docs.datadoghq.com/tracing/trace_collection/library_config/nodejs).

<h3 id="custom-logging">Custom Logging</h3>

By default, logging from this library is disabled. In order to get debugging information and errors sent to logs, the `DD_TRACE_DEBUG` env var should be set to `true`.

The tracer will then log debug information to `console.log()` and errors to `console.error()`. This behavior can be changed by passing a custom logger to the tracer. The logger should contain a `debug()` and `error()` methods that can handle messages and errors, respectively.

For example:

```javascript
const bunyan = require('bunyan')
const logger = bunyan.createLogger({
  name: 'dd-trace',
  level: 'trace'
})

process.env.DD_TRACE_DEBUG = 'true'

const tracer = require('dd-trace').init({
  logger: {
    error: err => logger.error(err),
    warn: message => logger.warn(message),
    info: message => logger.info(message),
    debug: message => logger.trace(message),
  }
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
