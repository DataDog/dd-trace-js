# Contributing to dd-trace-js

Please reach out before starting work on any major code changes.
This will ensure we avoid duplicating work, or that your code can't be merged due to a rapidly changing
base. If you would like support for a module that is not listed, [contact support][1] to share a request.

## Keep changes small and incremental

Changes should be incremental and understandable. As much as possible, large-scale efforts should be broken up into many PRs over time for better reviewability. If a feature would require more changes to be "complete" it's fine to land partial changes if they are not wired up to anything yet, so long as tests are included which at least prove those parts work in isolation.

There are great benefits to taking a measured and iterative approach to improvement. When working on code in fewer places there is far less risk of running into merge conflicts or incompatibilities with other systems. Keeping contributions small makes them easy to review which makes that much quicker to land. Additionally, keeping things small and iterative makes it easier for other teams to review and understand what the code does.

## Be descriptive

Sometimes code can be self-documenting, but often it can't. That is especially true to someone reviewing code they haven't worked on. Be conscious of writing code in a self-describing way and leave comments anywhere that self-description fails. This goes a long way towards making even complex code coherent to one not already familiar with it.

Try to write code in a way the describes the intent when read. For example, verbs can be used for function and method names to communicate that they are used to do some specific action. In doing so it becomes clear when referenced by name elsewhere that it is a function and what the function is meant to do. If a function can not be described with a simple verb it's probably too complex or does too many things.

## Give your code space

Very dense code is hard to read. It helps to make use of empty lines to separate logical groupings of statements. Long lines should be split up into multiple lines to make them more readable. Complex objects or arrays should generally be split over several lines. Sometimes it's a good idea to assign a variable only to immediately use it in a call as it can be more descriptive than just using the expression in place. It's not always clear what an argument is for if it doesn't visibly have a name somehow. Remember, lines are free, our time is not.

## Avoid large refactors

Large refactors should generally be avoided in favour of iterative approaches. For example, rather than rewriting how every plugin works, one might make a special-case plugin that works a bit different for their particular use-case. If several dozen files need to change to add a feature we've probably done something wrong.

Sometimes new patterns or new ideas emerge which would be a substantial improvement over the existing state. It can be tempting to want to go all-in on a new way to do something, but the code churn can be hard to manage. It's best to introduce such new things incrementally and advocate for their adoption gradually through the rest of the codebase. As old systems are gradually phased out, the infrastructure which supports them can be deleted or relegated to lazy-loading only if and when that specific part of the system needs to be used.

## Test everything

It's very difficult to know if a change is valid unless there are tests to prove it. As an extension of that, it's also difficult to know the _use_ of that code is valid if the way it is integrated is not propertly tested. For this reason we generally favour integration tests over unit tests. If an API is expected to be used in different places or in different ways then it should generally include unit tests too for each unique scenario, however great care should be taken to ensure unit tests are actually testing the _logic_ and not just testing the _mocks_. It's a very common mistake to write a unit test that abstracts away the actual use of the interface so much that it doesn't actually test how that interface works in real-world scenarios. Remember to test how it handles failures, how it operates under heavy load, and how it impacts usability of what its purpose is.

## Don't forget benchmarks

Observability products tend to have quite a bit of their behaviour running in app code hot paths. It's important we extensively benchmark anything we expect to have heavy use to ensure it performs well and we don't cause any significant regressions through future changes. Measuring once at the time of writing is insufficient--a graph with just one data point is not going to tell you much of anything.

## Always consider backportability

To reduce delta between release lines and make it easier for us to support older versions we try as much as possible to backport every change we can. We should be diligent about keeping breaking changes to a minimum and ensuring we don't use language or runtime features which are too new. This way we can generally be confident that a change can be backported.

To reduce the surface area of a breaking change, the breaking aspects could be placed behind a flag which is disabled by default or isolated to a function. In the next major the change would then be just to change the default of the flag or to start or stop calling the isolated function. By isolating the breaking logic it also becomes easier to delete later when it's no longer relevant on any release line.

Currently we do not have CI to test PRs for mergeability to past release lines, but we intend to expand our CI to include that in the future. For the time being, it's recommended when developing locally to try to cherry-pick your changes onto the previous vN.x branches to see if the tests pass there too.

## Respect semantic versioning

This library follows the semantic versioning standard, but there are some subtleties left under-specified so this section is meant to clarify exactly how we interpret the meaning of semver. Additionally, it exists to communicate that we also use semver labels on all PRs to indicate which type of release the change should land in. Outside contributions should be evaluated and a semver label selected by the relevant team.

### semver-patch

If the change is a bug or security fix, it should be labelled as semver-patch. These changes should generally not alter existing behaviour in any way other than to correct the specific issue.

### semver-minor

Any addition of new functionality should be labelled as semver-minor and should not change any existing behaviour either in how any existing API works or in changing the contents or value of any existing data being reported except in purely additive cases where all existing data retains its prior state. Such changes may include new configuration options which when used will change behaviour, or may include the addition of new data being captured such as a new instrumentation, but should not impact the current operating design of any existing features.

### semver-major

In the event that some existing functionality _does_ need to change, as much as possible the non-breaking aspects of that change should be made in a semver-minor PR and the actually breaking aspects should be done via a follow-up PR with only the specific aspects which are breaking. Remember to [always consider backportability](#always-consider-backportability).

## Indicate intended release targets

When writing major changes we use a series of labels in the form of `dont-land-on-vN.x` where N is the major release line which a PR should not land in. Every PR marked as semver-major should include these tags. These tags allow our [branch-diff](https://github.com/bengl/branch-diff) tooling to work smoothly as we can exclude PRs not intended for the release line we're preparing a release proposal for. The `semver-major` labels on their own are not sufficient as they don't encode any indication of from _which_ releases they are a major change.

For outside contributions we will have the relevant team add these labels when they review and determine when they plan to release it.

## Ensure all tests are green

We follow an all-green policy which means that for any PR to be merged _all_ tests must be passing. If a test is flaky or failing consistently the owner of that test should make it a priority to fix that test and unblock other teams from landing changes. For outside contributors there are currently several tests which will always fail as full CI permission is required. For these PRs our current process is for the relevant team to copy the PR and resubmit it to run tests as a user with full CI permission.

Eventually we plan to look into putting these permission-required tests behind a label which team members can add to their PRs at creation to run the full CI and can add to outside contributor PRs to trigger the CI from their own user credentials. If the label is not present there will be another action which checks the label is present. Rather than showing a bunch of confusing failures to new contributors it would just show a single job failure which indicates an additional label is required, and we can name it in a way that makes it clear that it's not the responsibility of the outside contributor to add it. Something like `approve-full-ci` is one possible choice there.

## Development Requirements

Since this project supports multiple Node.js versions, using a version manager
such as [nvm](https://github.com/creationix/nvm) is recommended. If you're
unsure which version of Node.js to use, just use the latest version, which
should always work.

We use [yarn](https://yarnpkg.com/) 1.x for its workspace functionality, so make sure to install that as well. The easist way to install yarn 1.x with with npm:

```sh
$ npm install -g yarn
```

To install dependencies once you have Node and yarn installed, run this in the project directory:

```sh
$ yarn
```

## Adding a Plugin

To create a new plugin for a third-party package, follow these steps:

1. `mkdir -p packages/datadog-plugin-<pluginname>/src`
2. Copy an `index.js` file from another plugin to use as a starting point: `cp packages/datadog-plugin-kafkajs/src/index.js packages/datadog-plugin-<pluginname>/src`
3. Edit index.js as appropriate for your new plugin
4. `mkdir -p packages/datadog-plugin-<pluginname>/test`
5. Create an packages/datadog-plugin-<pluginname>/test/index.spec.js file and add the necessary tests. See other plugin tests for inspiration to file structure.
6. Edit index.spec.js as appropriate for your new plugin
7. Add entries to the following files for your new plugin:
  - `packages/dd-trace/src/plugins/index.js`
  - `index.d.ts`
  - `docs/test.ts`
  - `docs/API.md`
  - `.github/workflows/apm-integrations.yml`

### Adding a Plugin Test to CI

The plugin tests run on pull requests in Github Actions. Each plugin test suite has its own Github job, so adding a new suite to CI
requires adding a new job to the Github Actions config. The file containing these configs is `.github/workflows/apm-integrations.yml`.
You can copypaste and modify an existing plugin job configuration in this file to create a new job config.

## Testing

### Prerequisites

The `pg-native` package requires `pg_config` to be in your `$PATH` to be able to install.
Please refer to [the "Install" section](https://github.com/brianc/node-postgres/tree/master/packages/pg-native#install) of the `pg-native` documentation for how to ensure your environment is configured correctly.

### Plugin Tests

Before running _plugin_ tests, the supporting docker containers need to be running. You _can_ attempt to start all of them using docker-compose, but that's a drain on your system, and not all the images will even run at all on AMD64 devices.

> **Note**
> The `aerospike`, `couchbase`, `grpc` and `oracledb` instrumentations rely on
> native modules that do not compile on ARM64 devices (for example M1/M2 Mac)
> - their tests cannot be run locally on these devices.

Instead, you can follow this procedure for the plugin you want to run tests for:

1. Check the CI config in `.github/workflows/*.yml` to see what the appropriate values for the `SERVICES` and `PLUGINS` environment variables are for the plugin you're trying to test (noting that not all plugins require `SERVICES`). For example, for the `amqplib` plugin, the `SERVICES` value is `rabbitmq`, and the `PLUGINS` value is `amqplib`.
2. Run the appropriate docker-compose command to start the required services. For example, for the `amqplib` plugin, you would run: `docker compose up -d rabbitmq`.
3. Run `yarn services`, with the environment variables set above. This will install any versions of the library to be tested against into the `versions` directory, and check that the appropriate services are running prior to running the test.
4. Now, you can run `yarn test:plugins` with the environment variables set above to run the tests for the plugin you're interested in.

To wrap that all up into a simple few lines of shell commands, here is all of the above, for the `amqplib` plugin:

```sh
# These are exported for simplicity, but you can also just set them inline.
export SERVICES="rabbitmq" # retrieved from .github/workflows/apm-integrations.yml
export PLUGINS="amqplib" # retrieved from .github/workflows/apm-integrations.yml

docker compose up -d $SERVICES
yarn services

yarn test:plugins # This one actually runs the tests. Can be run many times.
```

You can also run the tests for multiple plugins at once by separating them with a pipe (`|`) delimiter. For example, to run the tests for the `amqplib` and `bluebird` plugins:

```sh
PLUGINS="amqplib|bluebird" yarn test:plugins
```

### Other Unit Tests

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

### Linting

We use [ESLint](https://eslint.org) to make sure that new code
conforms to our coding standards.

To run the linter, use:

```sh
$ yarn lint
```

This also checks that the `LICENSE-3rdparty.csv` file is up-to-date, and checks
dependencies for vulnerabilities.


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


[1]: https://docs.datadoghq.com/help
