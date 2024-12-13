# `dd-trace`: Node.js APM Tracer Library

[![npm v5](https://img.shields.io/npm/v/dd-trace/latest?color=blue&label=dd-trace%40v5&logo=npm)](https://www.npmjs.com/package/dd-trace)
[![npm v4](https://img.shields.io/npm/v/dd-trace/latest-node16?color=blue&label=dd-trace%40v4&logo=npm)](https://www.npmjs.com/package/dd-trace/v/latest-node16)
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
| [`v2`](https://github.com/DataDog/dd-trace-js/tree/v2.x) | ![npm v2](https://img.shields.io/npm/v/dd-trace/latest-node12?color=white&label=%20&style=flat-square) | `>= v12` | **End of Life** | 2022-01-28     | 2023-08-15  |
| [`v3`](https://github.com/DataDog/dd-trace-js/tree/v3.x) | ![npm v3](https://img.shields.io/npm/v/dd-trace/latest-node14?color=white&label=%20&style=flat-square) | `>= v14` | **End of Life** | 2022-08-15     | 2024-05-15  |
| [`v4`](https://github.com/DataDog/dd-trace-js/tree/v4.x) | ![npm v4](https://img.shields.io/npm/v/dd-trace/latest-node16?color=white&label=%20&style=flat-square)        | `>= v16` | **Maintenance**     | 2023-05-12     | 2025-01-11     |
| [`v5`](https://github.com/DataDog/dd-trace-js/tree/v5.x) | ![npm v5](https://img.shields.io/npm/v/dd-trace/latest?color=white&label=%20&style=flat-square)        | `>= v18` | **Current**     | 2024-01-11     | Unknown     |

We currently maintain two release lines, namely `v5`, and `v4`.
Features and bug fixes that are merged are released to the `v5` line and, if appropriate, also `v4`.

For any new projects it is recommended to use the `v5` release line:

```sh
$ npm install dd-trace
$ yarn add dd-trace
```

However, existing projects that already use the `v4` release line, or projects that need to support EOL versions of Node.js, may continue to use these release lines.
This is done by specifying the version when installing the package.

```sh
$ npm install dd-trace@4
$ yarn add dd-trace@4
```

Any backwards-breaking functionality that is introduced into the library will result in an increase of the major version of the library and therefore a new release line.
Such releases are kept to a minimum to reduce the pain of upgrading the library.

When a new release line is introduced the previous release line then enters maintenance mode where it will receive updates for the next year.
Once that year is up the release line enters End of Life and will not receive new updates.
The library also follows the Node.js LTS lifecycle wherein new release lines drop compatibility with Node.js versions that reach end of life (with the maintenance release line still receiving updates for a year).

For more information about library versioning and compatibility, see the [NodeJS Compatibility Requirements](https://docs.datadoghq.com/tracing/trace_collection/compatibility/nodejs/#releases) page.

Changes associated with each individual release are documented on the [GitHub Releases](https://github.com/DataDog/dd-trace-js/releases) screen.


## Development and Contribution

Please read the [CONTRIBUTING.md](https://github.com/DataDog/dd-trace-js/blob/master/CONTRIBUTING.md) document before contributing to this open source project.


## EcmaScript Modules (ESM) Support

ESM support requires an additional command-line argument. Use the following to enable experimental ESM support with your application:

Node.js < v20.6

```sh
node --loader dd-trace/loader-hook.mjs entrypoint.js
```

Node.js >= v20.6

```sh
node --import dd-trace/register.js entrypoint.js
```

## Serverless / Lambda

Note that there is a separate Lambda project, [datadog-lambda-js](https://github.com/DataDog/datadog-lambda-js), that is responsible for enabling metrics and distributed tracing when your application runs on Lambda.
That project does depend on the `dd-trace` package but also adds a lot of Lambda-related niceties.
If you find any issues specific to Lambda integrations then the issues may get solved quicker if they're added to that repository.
That said, even if your application runs on Lambda, any core instrumentation issues not related to Lambda itself may be better served by opening an issue in this repository.
Regardless of where you open the issue, someone at Datadog will try to help.


## Bundling

If you would like to trace your bundled application then please read this page on [bundling and dd-trace](https://docs.datadoghq.com/tracing/trace_collection/automatic_instrumentation/dd_libraries/nodejs/#bundling). It includes information on how to use our ESBuild plugin and includes caveats for other bundlers.


## Security Vulnerabilities

Please refer to the [SECURITY.md](https://github.com/DataDog/dd-trace-js/blob/master/SECURITY.md) document if you have found a security issue.


## Datadog With OpenTelemetery

Please refer to the [Node.js Custom Instrumentation using OpenTelemetry API](https://docs.datadoghq.com/tracing/trace_collection/custom_instrumentation/nodejs/otel/) document. It includes information on how to use the OpenTelemetry API with dd-trace-js.

Note that our internal implementation of the OpenTelemetry API is currently set within the version range `>=1.0.0 <1.9.0`. This range will be updated at a regular cadence therefore, we recommend updating your tracer to the latest release to ensure up to date support.
