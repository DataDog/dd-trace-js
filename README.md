# @chatlayer/tracer

**Node.js APM Tracer**

APM tracing client for Node.js.
Adapted from the Datadog tracer to be compatible with the opentelemtry tracing api.

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

### Benchmarks

When two or more approaches must be compared, please write a benchmark
in the `benchmark/index.js` module so that we can keep track of the
most efficient algorithm. To run your benchmark, just:

```sh
$ yarn bench
```
