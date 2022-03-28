# dd-trace-js 

[![npm](https://img.shields.io/npm/v/dd-trace.svg?colorB=blue)](https://www.npmjs.com/package/dd-trace)
[![npm (tag)](https://img.shields.io/npm/v/dd-trace/dev.svg)](https://www.npmjs.com/package/dd-trace/v/dev)
[![CircleCI](https://circleci.com/gh/DataDog/dd-trace-js.svg?style=shield)](https://circleci.com/gh/DataDog/dd-trace-js)
[![codecov](https://codecov.io/gh/DataDog/dd-trace-js/branch/master/graph/badge.svg)](https://codecov.io/gh/DataDog/dd-trace-js)

**Node.js APM Tracer**

Datadog APM tracing client for Node.js.

## Getting Started

For a basic product overview, check out our [setup documentation](https://docs.datadoghq.com/tracing/languages/nodejs/).

For installation, configuration, and details about using the API, check out our [API documentation](https://datadog.github.io/dd-trace-js).

For descriptions of terminology used in APM, take a look at the [official documentation](https://docs.datadoghq.com/tracing/visualization/).

## Development

Before contributing to this open source project, read our [CONTRIBUTING.md](https://github.com/DataDog/dd-trace-js/blob/master/CONTRIBUTING.md).

### Requirements

Since this project supports multiple Node versions, using a version
manager such as [nvm](https://github.com/creationix/nvm) is recommended.

We use [yarn](https://yarnpkg.com/) for its workspace functionality, so make sure to install that as well.

To get started once you have Node and yarn installed, run:

```sh
$ yarn
```

### Testing

Before running the tests, the data stores need to be running.
The easiest way to start all of them is to use the provided
docker-compose configuration:

```sh
$ docker-compose up -d -V --remove-orphans --force-recreate
```

#### Unit Tests

To run the unit tests, use:

```sh
$ yarn test
```

To run the unit tests continuously in watch mode while developing, use:

```sh
$ yarn tdd
```

#### Memory Leaks

To run the memory leak tests, use:

```sh
$ yarn leak
```

Please note that memory leak tests only run on Node `>=8`.

### Linting

We use [ESLint](https://eslint.org) to make sure that new code is
conform to our coding standards.

To run the linter, use:

```sh
$ yarn lint
```

### Continuous Integration

We rely on CircleCI 2.0 for our tests. If you want to test how the CI behaves
locally, you can use the CircleCI Command Line Interface as described here:
https://circleci.com/docs/2.0/local-jobs/

After installing the `circleci` CLI, simply run one of the following:

```sh
$ circleci build --job lint
$ circleci build --job node-leaks
$ circleci build --job node-core-8
$ circleci build --job node-core-10
$ circleci build --job node-core-12
$ circleci build --job node-core-latest
```

### Benchmarks

When two or more approaches must be compared, please write a benchmark
in the `benchmark/index.js` module so that we can keep track of the
most efficient algorithm. To run your benchmark, just:

```sh
$ yarn bench
```
