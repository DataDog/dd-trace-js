# dd-trace-js

[![npm](https://img.shields.io/npm/v/dd-trace.svg?colorB=blue)](https://www.npmjs.com/package/dd-trace)
[![npm (tag)](https://img.shields.io/npm/v/dd-trace/dev.svg)](https://www.npmjs.com/package/dd-trace/v/dev)
[![codecov](https://codecov.io/gh/DataDog/dd-trace-js/branch/master/graph/badge.svg)](https://codecov.io/gh/DataDog/dd-trace-js)

**Node.js APM Tracer**

Datadog APM tracing client for Node.js.

## Getting Started

For a basic product overview, check out our [setup documentation](https://docs.datadoghq.com/tracing/languages/nodejs/).

For installation, configuration, and details about using the API, check out our [API documentation](https://datadog.github.io/dd-trace-js).

For descriptions of terminology used in APM, take a look at the [official documentation](https://docs.datadoghq.com/tracing/visualization/).

## Development

Before contributing to this open source project, read our [CONTRIBUTING.md](https://github.com/DataDog/dd-trace-js/blob/master/CONTRIBUTING.md).

## Security Vulnerabilities

If you have found a security issue, please contact the security team directly at [security@datadoghq.com](mailto:security@datadoghq.com).

## Requirements

Since this project supports multiple Node versions, using a version
manager such as [nvm](https://github.com/creationix/nvm) is recommended.

We use [yarn](https://yarnpkg.com/) for its workspace functionality, so make sure to install that as well.

To get started once you have Node and yarn installed, run:

```sh
$ yarn
```

## Testing

Before running _plugin_ tests, the data stores need to be running.
The easiest way to start all of them is to use the provided
docker-compose configuration:

```sh
$ docker-compose up -d -V --remove-orphans --force-recreate
```

### Unit Tests

There are several types of unit tests, for various types of components. The
following commands may be useful:

```sh
# Tracer core tests (i.e. testing `packages/dd-trace`)
yarn test:trace:core
# "Core" library tests (i.e. testing `packages/datadog-core`
yarn test:core
# Instrumentations tests (i.e. testing `packages/datadog-instrumentations`
yarn test:instrumentations
```

Several other components have test commands as well. See `package.json` for
details.

To test _plugins_ (i.e. compenents in `packages/datadog-plugin-XXXX`
directories, set the `PLUGINS` environment variable to the plugin you're
interested in, and use `yarn test:plugins. Here's an example testing the
`express` plugin.

```sh
PLUGINS=express yarn test:plugins
```

To run the unit tests continuously in watch mode while developing, use:

```sh
$ yarn tdd
```

### Memory Leaks

To run the memory leak tests, use:

```sh
yarn leak:core

# or

yarn leak:plugins
```

Please note that memory leak tests only run on Node `>=8`.

## Linting

We use [ESLint](https://eslint.org) to make sure that new code is
conform to our coding standards.

To run the linter, use:

```sh
$ yarn lint
```

### Benchmarks

Our microbenchmarks live in `benchmark/sirun`. Each directory in there
correspondes to a specific benchmark test and its variants, which are used to
track regressions and improvements over time.

In addition to those, when two or more approaches must be compared, please write
a benchmark in the `benchmark/index.js` module so that we can keep track of the
most efficient algorithm. To run your benchmark, use:

```sh
$ yarn bench
```


