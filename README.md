# dd-trace-js
Experimental JavaScript tracer (APM)

## Installation

### NodeJS

```sh
npm install --save dd-trace
```

*Node >= 4 is required.*

## Usage

### Examples

```js
const { tracer } = require('dd-trace').init({ service: 'example' })
const express = require('express')
const app = express()

app.get('/hello/:name', (req, res) => {
  const span = tracer.startSpan('say_hello')

  span.addTags({
    'resource': '/hello/:name', // required by Datadog
    'type': 'web', // required by Datadog
    'span.kind': 'server',
    'http.method': 'GET',
    'http.url': req.url,
    'http.status_code': '200'
  })

  span.finish()

  res.send(`Hello, ${req.params.name}!`)
})

app.listen(3000)
```

### Available Options

* **service**: name of the Datadog service
* **hostname**: hostname of the Datadog agent *(default: localhost)*
* **port**: port of the Datadog agent *(default: 8126)*
* **protocol**: protocol of the Datadog agent *(default: http)*
* **flushInterval**: interval in milliseconds at which traces will be flushed to the agent *(default: 2000)*
* **bufferSize**: number of accumulated traces before they will be flushed to the agent  *(default: 1000)*

### OpenTracing

This library is OpenTracing compliant, so once the tracer is initialized
it can be used like any other custom tracer:

```js
const { tracer } = require('dd-trace').init(options)
const opentracing = require('opentracing')

opentracing.initGlobalTracer(tracer)
```

Then the tracer will be available with `opentracing.globalTracer()`.

See the OpenTracing JavaScript [documentation](https://github.com/opentracing/opentracing-javascript)
and [API](https://doc.esdoc.org/github.com/opentracing/opentracing-javascript/) for more details.

## Development

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
