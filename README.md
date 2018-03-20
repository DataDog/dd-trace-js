# dd-trace-js

**Experimental JavaScript Tracer!**

This project is **experimental** and under active development. Use it at your own risk.

## Installation

### NodeJS

```sh
npm install --save dd-trace
```

*Node >= 4 is required.*

## Usage

### Example

```js
const tracer = require('dd-trace').init({
  service: 'example'
})

const express = require('express')
const app = express()

app.get('/hello/:name', (req, res) => {
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
    res.send(`Hello, ${req.params.name}!`)
    span.finish()
  })
})

app.listen(3000)
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
| experimental  |                              | {}        | Experimental features can be enabled all at once using boolean `true` or individually using key/value pairs. Available experimental features: `asyncHooks`.

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

## Development

### NOTE

Due to the experimental pre-beta nature of this repository, you should reach out before starting work on
any major code changes. This will ensure we avoid duplicating work, or that your code can't be merged due
to a rapidly changing base. If you have any questions, let us know!

### Requirements

Since this project supports multiple Node versions, using a version
manager such as [nvm](https://github.com/creationix/nvm) is recommended.

To get started once you have a Node version installed, run:

```sh
$ npm install
```

### Testing

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
