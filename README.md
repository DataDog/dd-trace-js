# dd-trace-js

[![npm](https://img.shields.io/npm/v/dd-trace.svg)](https://www.npmjs.com/package/dd-trace)
[![CircleCI](https://img.shields.io/circleci/project/github/DataDog/dd-trace-js.svg)](https://circleci.com/gh/DataDog/dd-trace-js/tree/master)

**Experimental JavaScript Tracer!**

This project is **experimental** and under active development. Use it at your own risk.

## Installation

### NodeJS

```sh
npm install --save dd-trace
```

*Node >= 4 is required.*

## Usage

Simply require and initialize the tracer and all supported
[libraries](#automatic-instrumentation) will automatically
be instrumented.

```js
// The tracer must be initialized before other libraries
const tracer = require('dd-trace').init()
```

### Available Options

Options can be configured as a parameter to the `init()` method
or as environment variables.

| Config        | Environment Variable         | Default   | Description |
| ------------- | ---------------------------- | --------- | ----------- |
| debug         | DD_TRACE_DEBUG               | false     | Enable debug logging in the tracer. |
| service       | DD_SERVICE_NAME              |           | The service name to be used for this program. |
| hostname      | DD_TRACE_AGENT_HOSTNAME      | localhost | The address of the trace agent that the tracer will submit to. |
| port          | DD_TRACE_AGENT_PORT          | 8126      | The port of the trace agent that the tracer will submit to. |
| flushInterval |                              | 2000      | Interval in milliseconds at which the tracer will submit traces to the agent. |
| experimental  |                              | {}        | Experimental features can be enabled all at once using boolean `true` or individually using key/value pairs. Available experimental features: `asyncHooks`. |
| plugins       |                              | true      | Whether or not to enable automatic instrumentation of external libraries using the built-in plugins. |

### Automatic Instrumentation

The following libraries are instrumented automatically by default:

* [http](https://nodejs.org/api/http.html)
* [express](https://expressjs.com/) (version 4)
* [pg](https://node-postgres.com/) (version 6)

### OpenTracing

This library is OpenTracing compliant, so once the tracer is initialized
it can be used as a global tracer.

```js
const tracer = require('dd-trace').init()
const opentracing = require('opentracing')

opentracing.initGlobalTracer(tracer)
```

Then the tracer will be available with `opentracing.globalTracer()`.

See the OpenTracing JavaScript [documentation](https://github.com/opentracing/opentracing-javascript)
and [API](https://doc.esdoc.org/github.com/opentracing/opentracing-javascript/) for more details.

**NOTE: When using OpenTracing, context propagation is not handled
automatically.**

## Advanced Usage

In some cases you may want to do manual instrumentation. For example
if there is no built-in plugin covering a library you are using or if you want more control on how instrumentation is done.

### Manual instrumentation

```js
const tracer = require('dd-trace').init()
const http = require('http')

const server = http.createServer((req, res) => {
  const options = {
    resource: '/hello/:name',
    type: 'web',
    tags: {
      'span.kind': 'server',
      'http.method': 'GET',
      'http.url': req.url,
      'http.status_code': '200'
    }
  }

  tracer.trace('say_hello', options, span => {
    res.write('Hello, World!')
    span.finish()
  })

  res.end()
})

server.listen(8000)
```

## Development

Before contributing to this open source project, read our [CONTRIBUTING.md](https://github.com/DataDog/dd-trace-js/blob/master/CONTRIBUTING.md).

### Requirements

Since this project supports multiple Node versions, using a version
manager such as [nvm](https://github.com/creationix/nvm) is recommended.

To get started once you have a Node version installed, run:

```sh
$ npm install
```

### Testing

Before running the tests, the data stores need to be running.
The easiest way to start all of them is to use the provided
docker-compose configuration:

```sh
$ docker-compose up -d
```

To run the unit tests, use:

```sh
$ npm test
```

To run the unit tests continuously in watch mode while developing, use:

```sh
$ npm run tdd
```

### Linting

We use [ESLint](https://eslint.org) to make sure that new code is
conform to our coding standards.

To run the linter, use:

```sh
$ npm run lint
```

### Continuous Integration

We rely on CircleCI 2.0 for our tests. If you want to test how the CI behaves
locally, you can use the CircleCI Command Line Interface as described here:
https://circleci.com/docs/2.0/local-jobs/

After installing the `circleci` CLI, simply run one of the following:

```sh
$ circleci build --job lint
$ circleci build --job build-node-4
$ circleci build --job build-node-6
$ circleci build --job build-node-8
$ circleci build --job build-node-latest
```

### Benchmarks

When two or more approaches must be compared, please write a benchmark
in the `benchmark/index.js` module so that we can keep track of the
most efficient algorithm. To run your benchmark, just:

```sh
$ npm run bench
```
