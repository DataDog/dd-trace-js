# `dd-trace`: Node.js APM Tracer Library

[![npm v3](https://img.shields.io/npm/v/dd-trace/latest?color=blue&label=dd-trace%40v3&logo=npm)](https://www.npmjs.com/package/dd-trace)
[![npm v2](https://img.shields.io/npm/v/dd-trace/latest-node12?color=blue&label=dd-trace%40v2&logo=npm)](https://www.npmjs.com/package/dd-trace/v/latest-node12)
[![npm dev](https://img.shields.io/npm/v/dd-trace/dev?color=orange&label=dd-trace%40dev&logo=npm)](https://www.npmjs.com/package/dd-trace/v/dev)
[![codecov](https://codecov.io/gh/DataDog/dd-trace-js/branch/master/graph/badge.svg)](https://codecov.io/gh/DataDog/dd-trace-js)

<img align="right" src="https://user-images.githubusercontent.com/551402/208212084-1d0c07e2-4135-4c61-b2da-8f2fddbc66ed.png" alt="Bits the dog  JavaScript" width="200px"/>

`dd-trace` is an npm package that you can install in your Node.js application to capture APM (Application Performance Monitoring) data. In Datadog terminology this library is called a Tracer. This data is then sent off to a process which collects and aggregates the data, called an Agent. Finally the data is sent off to the Datadog servers where it's stored and made available for querying in a myriad of ways, such as displaying in a dashboard or triggering alerts.

![Tracer, Agent, Datadog relationship diagram](./docs/relationship.png)


## Documentation

Most of the documentation for `dd-trace` is available on these webpages:

- [Tracing Node.js Applications](https://docs.datadoghq.com/tracing/languages/nodejs/) - most project documentation, including setup instructions
- [Configuring the NodeJS Tracing Library](https://docs.datadoghq.com/tracing/trace_collection/library_config/nodejs) - environment variables and config options
- [API Documentation](https://datadog.github.io/dd-trace-js) - method signatures, plugin list, and some usage examples
- [APM Terms and Concepts](https://docs.datadoghq.com/tracing/visualization/) - a glossary of concepts applicable across all languages


## Version Release Lines and Maintenance

| Release Line                                             | Latest Version                                                                                         | Node.js  | Status          |Initial Release | End of Life |
| :---:                                                    | :---:                                                                                                  | :---:    | :---:           | :---:          | :---:       |
| [`v1`](https://github.com/DataDog/dd-trace-js/tree/v1.x) | ![npm v1](https://img.shields.io/npm/v/dd-trace/legacy-v1?color=white&label=%20&style=flat-square)     | `>= v12` | **End of Life** | 2021-07-13     | 2022-02-25  |
| [`v2`](https://github.com/DataDog/dd-trace-js/tree/v2.x) | ![npm v2](https://img.shields.io/npm/v/dd-trace/latest-node12?color=white&label=%20&style=flat-square) | `>= v12` | **Maintenance** | 2022-01-28     | 2023-08-15  |
| [`v3`](https://github.com/DataDog/dd-trace-js/tree/v3.x) | ![npm v3](https://img.shields.io/npm/v/dd-trace/latest?color=white&label=%20&style=flat-square)        | `>= v14` | **Current**     | 2022-08-15     | Unknown     |

We currently maintain two release lines, namely `v2` and `v3`.
Features and bug fixes that are merged are released to the `v3` line and, if appropriate, also the `v2` line.

For any new projects it is recommended to use the `v3` release line:

```sh
$ npm install dd-trace
$ yarn add dd-trace
```

However, existing projects that already use the `v2` release line, or projects that need to support Node.js v12, may use the `v2` release line.
This is done by specifying the version when installing the package.
Note that we also publish to npm using a `latest-node12` tag that can also be used for install:

```sh
$ npm install dd-trace@2
$ yarn add dd-trace@2
$ npm install dd-trace@latest-node12
$ yarn add dd-trace@latest-node12
```

Any backwards-breaking functionality that is introduced into the library will result in an increase of the major version of the library and therefore a new release line.
Such releases are kept to a minimum to reduce the pain of upgrading the library.

When a new release line is introduced the previous release line then enters maintenance mode where it will receive updates for the next year.
Once that year is up the release line enters End of Life and will not receive new updates.
The library also follows the Node.js LTS lifecycle wherein new release lines drop compatibility with Node.js versions that reach end of life (with the maintenance release line still receiving updates for a year).

For more information about library versioning and compatibility, see the [NodeJS Compatibility Requirements](https://docs.datadoghq.com/tracing/trace_collection/compatibility/nodejs/#releases) page.

Changes associated with each individual release are documented on the [GitHub Releases](https://github.com/DataDog/dd-trace-js/releases) screen.


## Development

Before contributing to this open source project, read our [CONTRIBUTING.md](https://github.com/DataDog/dd-trace-js/blob/master/CONTRIBUTING.md).


## Requirements

Since this project supports multiple Node versions, using a version
manager such as [nvm](https://github.com/creationix/nvm) is recommended.

We use [yarn](https://yarnpkg.com/) for its workspace functionality, so make sure to install that as well.

To install dependencies once you have Node and yarn installed, run:

```sh
$ yarn
```


## Testing

Before running _plugin_ tests, the data stores need to be running.
The easiest way to start all of them is to use the provided
docker-compose configuration:

```sh
$ docker-compose up -d -V --remove-orphans --force-recreate
$ yarn services
```


### Unit Tests

There are several types of unit tests, for various types of components. The
following commands may be useful:

```sh
# Tracer core tests (i.e. testing `packages/dd-trace`)
$ yarn test:trace:core
# "Core" library tests (i.e. testing `packages/datadog-core`
$ yarn test:core
# Instrumentations tests (i.e. testing `packages/datadog-instrumentations`
$ yarn test:instrumentations
```

Several other components have test commands as well. See `package.json` for
details.

To test _plugins_ (i.e. components in `packages/datadog-plugin-XXXX`
directories, set the `PLUGINS` environment variable to the plugin you're
interested in, and use `yarn test:plugins`. If you need to test multiple
plugins you may separate then with a pipe (`|`) delimiter. Here's an
example testing the `express` and `bluebird` plugins:

```sh
PLUGINS="express|bluebird" yarn test:plugins
```


### Memory Leaks

To run the memory leak tests, use:

```sh
$ yarn leak:core

# or

$ yarn leak:plugins
```


### Linting

We use [ESLint](https://eslint.org) to make sure that new code is
conform to our coding standards.

To run the linter, use:

```sh
$ yarn lint
```


### Benchmarks

Our microbenchmarks live in `benchmark/sirun`. Each directory in there
corresponds to a specific benchmark test and its variants, which are used to
track regressions and improvements over time.

In addition to those, when two or more approaches must be compared, please write
a benchmark in the `benchmark/index.js` module so that we can keep track of the
most efficient algorithm. To run your benchmark, use:

```sh
$ yarn bench
```


## Serverless / Lambda

Note that there is a separate Lambda project, [datadog-lambda-js](https://github.com/DataDog/datadog-lambda-js), that is responsible for enabling metrics and distributed tracing when your application runs on Lambda.
That project does depend on the `dd-trace` package but also adds a lot of Lambda-related niceties.
If you find any issues specific to Lambda integrations then the issues may get solved quicker if they're added to that repository.
That said, even if your application runs on Lambda, any core instrumentation issues not related to Lambda itself may be better served by opening an issue in this repository.
Regardless of where you open the issue, someone at Datadog will try to help.


## Security Vulnerabilities

If you have found a security issue, please contact the security team directly at [security@datadoghq.com](mailto:security@datadoghq.com).
