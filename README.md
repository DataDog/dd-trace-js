# dd-trace-js
Experimental JavaScript tracer (APM)

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

**Note:** ESLint only supports Node >= 4, so make sure you are using
a compatible Node version before running this command. We also
recommend using a plugin on your editor instead of constantly running
this command.

### Continuous Integration

We rely on CircleCI 2.0 for our tests. If you want to test how the CI behaves
locally, you can use the CircleCI Command Line Interface as described here:
https://circleci.com/docs/2.0/local-jobs/

After installing the `circleci` CLI, simply run one of the following:

```sh
$ circleci build --job lint
$ circleci build --job build-node-0.10
$ circleci build --job build-node-0.12
$ circleci build --job build-node-4
$ circleci build --job build-node-6
$ circleci build --job build-node-8
```

### Benchmarks

When two or more approaches must be compared, please write a benchmark
in the `benchmark/index.js` module so that we can keep track of the
most efficient algorithm. To run your benchmark, just:

```sh
$ npm run bench
```
