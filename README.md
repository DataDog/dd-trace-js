# ls-trace-js

[![npm](https://img.shields.io/npm/v/ls-trace.svg?colorB=blue)](https://www.npmjs.com/package/ls-trace)
[![npm (tag)](https://img.shields.io/npm/v/ls-trace/dev.svg)](https://www.npmjs.com/package/ls-trace/v/dev)
[![CircleCI](https://circleci.com/gh/lightstep/ls-trace-js.svg?style=shield)](https://circleci.com/gh/lightstep/ls-trace-js)
[![codecov](https://codecov.io/gh/lightstep/ls-trace-js/branch/master/graph/badge.svg)](https://codecov.io/gh/lightstep/ls-trace-js)
[![BrowserStack Status](https://automate.browserstack.com/badge.svg?badge_key=TU95QWlIQXhOcGw2YkdvVGpSYkNLK2QveGlwbmRYc3FSVFRtMUcza3hhQT0tLWErRVVDMFMvWnVIU3p5OE9ZSFJWeXc9PQ==--f63f623010664e0a1776325aefd8d119362f31d4)](https://automate.browserstack.com/public-build/TU95QWlIQXhOcGw2YkdvVGpSYkNLK2QveGlwbmRYc3FSVFRtMUcza3hhQT0tLWErRVVDMFMvWnVIU3p5OE9ZSFJWeXc9PQ==--f63f623010664e0a1776325aefd8d119362f31d4)

Datadog has generously announced the [donation](https://www.datadoghq.com/blog/opentelemetry-instrumentation) of their tracer libraries to the [OpenTelemety](https://opentelemetry.io/), project. Auto-instrumentation is a core feature of these libraries, making it possible to create and collect telemetry data without needing to change your code. LightStep wants you to be able to use these libraries now! `ls-trace-js` is LightStep's fork of Datadog’s tracing client for Javascript. You can install and use it to take advantage of auto-instrumentation without waiting for OpenTelemetry. Each LightStep agent is [“pinned” to a Datadog release](#versioning) and is fully supported by LightStep’s Customer Success team.

**JavaScript APM Tracer**

Datadog APM tracing client for JavaScript.

## Getting Started

For a basic product overview, check out our [setup documentation](https://docs.lightstep.com/docs/nodejs-auto-instrumentation)

For descriptions of terminology used in APM, take a look at the [official documentation](https://docs.lightstep.com/docs/understand-distributed-tracing)

## Development

Before contributing to this open source project, read our [CONTRIBUTING.md](https://github.com/lightstep/ls-trace-js/blob/master/CONTRIBUTING.md).

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
## Versioning

ls-trace follows its own versioning scheme. The table below shows the corresponding dd-trace-ls versions.

| ls-trace version | dd-trace-ls version |
|------------------|---------------------|
| v0.1.0           | v0.16.1             |

## Support

Contact `support@lightstep.com` for additional questions and resources, or to be added to our community slack channel.

## Licensing

This is a fork of [dd-trace-js][dd-trace-js repo] and retains the original Datadog license and copyright. See the [license][license file] for more details.

[dd-trace-js repo]: https://github.com/DataDog/dd-trace-js
[license file]: https://github.com/lightstep/ls-trace-js/blob/master/LICENSE
