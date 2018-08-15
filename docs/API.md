<h1 id="home">Datadog JavaScript Tracer API</h1>

This is the API documentation for the Datadog JavaScript Tracer. If you are just looking to get started, check out the [tracing setup documentation](https://docs.datadoghq.com/tracing/setup/javascript/).

<h2 id="overview">Overview</h2>

The module exported by this library is an instance of the [Tracer](./Tracer.html) class.

<h2 id="manual-instrumentation">Manual Instrumentation</h2>

If you aren’t using supported library instrumentation (see [Compatibility](#compatibility)), you may want to manually instrument your code.

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

In order to provide context propagation, this library includes a scope manager. A scope is basically a wrapper around a span that can cross both synchronous and asynchronous contexts.

For example:

```javascript
const tracer = require('dd-trace').init({ plugins: false })
const express = require('express')
const app = express()

app.use((req, res, next) => {
  const span = tracer.startSpan('web.request')
  const scope = tracer.scopeManager().activate(span)

  next()
})

app.get('/hello', (req, res, next) => {
  setTimeout(() => {
    const scope = tracer.scopeManager().active() // the scope activated earlier
    const span = scope.span() // the span wrapped by the scope

    span.finish()
    scope.close() // optional as the scope is automatically closed at the end of the current asynchronous context.

    res.status(200).send()
  }, 100)
})

app.listen(3000)
```

See the [API documentation](./ScopeManager.html) for usage.

<h2 id="integrations">Integrations</h2>

APM provides out-of-the-box instrumentation for many popular frameworks and libraries by using a plugin system. By default all built-in plugins are enabled. This behavior can be changed by setting the `plugins` option to `false` in the [tracer settings](#tracer-settings).

Built-in plugins can be enabled by name and configured individually:

```javascript
const tracer = require('dd-trace').init({ plugins: false })

// enable express integration
tracer.use('express')

// enable and configure postgresql integration
tracer.use('pg', {
  service: 'pg-cluster'
})
```

Each integration also has its own list of default tags. These tags get automatically added to the span created by the integration.

<h3 id="amqplib">amqplib</h3>

<h5 id="amqplib-tags">Tags</h5>

| Tag              | Description                                               |
|------------------|-----------------------------------------------------------|
| out.host         | The host of the AMQP server.                              |
| out.port         | The port of the AMQP server.                              |
| span.kind        | Set to either `producer` or `consumer` where it applies.  |
| amqp.queue       | The queue targeted by the command (when available).       |
| amqp.exchange    | The exchange targeted by the command (when available).    |
| amqp.routingKey  | The routing key targeted by the command (when available). |
| amqp.consumerTag | The consumer tag (when available).                        |
| amqp.source      | The source exchange of the binding (when available).      |
| amqp.destination | The destination exchange of the binding (when available). |

<h5 id="amqplib-config">Configuration Options</h5>

| Option           | Default                   | Description                            |
|------------------|---------------------------|----------------------------------------|
| service          | *Service name of the app* | The service name for this integration. |

<h3 id="elasticsearch">elasticsearch</h3>

<h5 id="elasticsearch-tags">Tags</h5>

| Tag                  | Description                                           |
|----------------------|-------------------------------------------------------|
| db.type              | Always set to `elasticsearch`.                        |
| out.host             | The host of the Elasticsearch server.                 |
| out.port             | The port of the Elasticsearch server.                 |
| span.kind            | Always set to `client`.                               |
| elasticsearch.method | The underlying HTTP request verb.                     |
| elasticsearch.url    | The underlying HTTP request URL path.                 |
| elasticsearch.body   | The body of the query.                                |
| elasticsearch.params | The parameters of the query.                          |

<h5 id="elasticsearch-config">Configuration Options</h5>

| Option           | Default          | Description                            |
|------------------|------------------|----------------------------------------|
| service          | elasticsearch    | The service name for this integration. |

<h3 id="express">express</h3>

<h5 id="express-tags">Tags</h5>

| Tag              | Description                                               |
|------------------|-----------------------------------------------------------|
| http.url         | The complete URL of the request.                          |
| http.method      | The HTTP method of the request.                           |
| http.status_code | The HTTP status code of the response.                     |

<h5 id="express-config">Configuration Options</h5>

| Option           | Default                   | Description                            |
|------------------|---------------------------|----------------------------------------|
| service          | *Service name of the app* | The service name for this integration. |
| validateStatus   | `code => code < 500`      | Callback function to determine if there was an error. It should take a status code as its only parameter and return `true` for success or `false` for errors. |

<h3 id="graphql">graphql</h3>

The `graphql` integration uses the operation name as the span resource name. If no operation name is set, the resource name will always be just `query` or `mutation`.

For example:

```graphql
# good, the resource name will be `query HelloWorld`
query HelloWorld {
  hello
  world
}

# bad, the resource name will be `query`
{
  hello
  world
}
```

<h5 id="graphql-tags">Tags</h5>

| Tag               | Description                                               |
|-------------------|-----------------------------------------------------------|
| graphql.document  | The original GraphQL document.                            |
| graphql.variables | The variables applied to the document.                    |

<h5 id="graphql-config">Configuration Options</h5>

| Option          | Default                                          | Description                                                      |
|-----------------|--------------------------------------------------|------------------------------------------------------------------|
| service         | *Service name of the app suffixed with -graphql* | The service name for this integration.                           |
| filterVariables | `variables => variables`                         | A callback that allows filtering of variables before submission. |

<h3 id="http">http / https</h3>

<h5 id="http-tags">Tags</h5>

| Tag              | Description                                               |
|------------------|-----------------------------------------------------------|
| http.url         | The complete URL of the request.                          |
| http.method      | The HTTP method of the request.                           |
| http.status_code | The HTTP status code of the response.                     |

<h5 id="http-config">Configuration Options</h5>

| Option           | Default          | Description                            |
|------------------|------------------|----------------------------------------|
| service          | http-client      | The service name for this integration. |
| splitByDomain    | false            | Use the remote endpoint host as the service name instead of the default. |

<h3 id="mongodb-core">mongodb-core</h3>

<h5 id="mongodb-core-tags">Tags</h5>

| Tag                  | Description                                           |
|----------------------|-------------------------------------------------------|
| db.name              | The qualified name of the queried collection.         |
| out.host             | The host of the MongoDB server.                       |
| out.port             | The port of the MongoDB server.                       |
| mongodb.cursor.index | When using a cursor, the current index of the cursor. |

<h5 id="mongodb-core-config">Configuration Options</h5>

| Option           | Default          | Description                            |
|------------------|------------------|----------------------------------------|
| service          | mongodb          | The service name for this integration. |

<h3 id="mysql">mysql</h3>

<h5 id="mysql-tags">Tags</h5>

| Tag              | Description                                               |
|------------------|-----------------------------------------------------------|
| db.name          | The name of the queried database.                         |
| db.user          | The user who made the query.                              |
| out.host         | The host of the MySQL server.                             |
| out.port         | The port of the MySQL server.                             |

<h5 id="mysql-config">Configuration Options</h5>

| Option           | Default          | Description                            |
|------------------|------------------|----------------------------------------|
| service          | mysql            | The service name for this integration. |

<h3 id="mysql2">mysql2</h3>

<h5 id="mysql2-tags">Tags</h5>

| Tag              | Description                                               |
|------------------|-----------------------------------------------------------|
| db.name          | The name of the queried database.                         |
| db.user          | The user who made the query.                              |
| out.host         | The host of the MySQL server.                             |
| out.port         | The port of the MySQL server.                             |

<h5 id="mysql2-config">Configuration Options</h5>

| Option           | Default          | Description                            |
|------------------|------------------|----------------------------------------|
| service          | mysql            | The service name for this integration. |

<h3 id="pg">pg</h3>

<h5 id="pg-tags">Tags</h5>

| Tag              | Description                                               |
|------------------|-----------------------------------------------------------|
| db.name          | The name of the queried database.                         |
| db.user          | The user who made the query.                              |
| out.host         | The host of the PostgreSQL server.                        |
| out.port         | The port of the PostgreSQL server.                        |

<h5 id="pg-config">Configuration Options</h5>

| Option           | Default          | Description                            |
|------------------|------------------|----------------------------------------|
| service          | postgres         | The service name for this integration. |

<h3 id="redis">redis</h3>

<h5 id="redis-tags">Tags</h5>

| Tag              | Description                                               |
|------------------|-----------------------------------------------------------|
| db.name          | The index of the queried database.                        |
| out.host         | The host of the Redis server.                             |
| out.port         | The port of the Redis server.                             |

<h5 id="redis-config">Configuration Options</h5>

| Option           | Default          | Description                            |
|------------------|------------------|----------------------------------------|
| service          | redis            | The service name for this integration. |

<h2 id="advanced-configuration">Advanced Configuration</h2>

<h3 id="tracer-settings">Tracer settings</h3>

Options can be configured as a parameter to the [init()](https://datadog.github.io/dd-trace-js/Tracer.html#init__anchor) method or as environment variables.

| Config        | Environment Variable         | Default   | Description |
| ------------- | ---------------------------- | --------- | ----------- |
| debug         | DD_TRACE_DEBUG               | false     | Enable debug logging in the tracer. |
| service       | DD_SERVICE_NAME              |           | The service name to be used for this program. |
| hostname      | DD_TRACE_AGENT_HOSTNAME      | localhost | The address of the trace agent that the tracer will submit to. |
| port          | DD_TRACE_AGENT_PORT          | 8126      | The port of the trace agent that the tracer will submit to. |
| env           | DD_ENV                       |           | Set an application’s environment e.g. `prod`, `pre-prod`, `stage`. |
| tags          |                              | {}        | Set global tags that should be applied to all spans. |
| sampleRate    |                              | 1         | Percentage of spans to sample as a float between 0 and 1. |
| flushInterval |                              | 2000      | Interval in milliseconds at which the tracer will submit traces to the agent. |
| experimental  |                              | {}        | Experimental features can be enabled all at once using boolean `true` or individually using key/value pairs. There are currently no experimental features available. |
| plugins       |                              | true      | Whether or not to enable automatic instrumentation of external libraries using the built-in plugins. |

<h3 id="custom-logging">Custom Logging</h3>

By default, logging from this library is disabled. In order to get debbuging information and errors sent to logs, the `debug` options should be set to `true` in the [init()](https://datadog.github.io/dd-trace-js/Tracer.html#init__anchor) method.

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
