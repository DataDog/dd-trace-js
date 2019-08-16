# Writing external tests configs

We can leverage an integration's own tests to ensure compatibility between the integration and our tracer. We do this by cloning the source repo of the integration and then running its tests through a test harness that injects and executes the tracer before the tests are run.

## Structure of the test config:

External test configurations are stored in a module called `external-tests.js` located at `datadog-plugin-<plugin>/test/external-tests.js`. The module exports an array of test configurations that the harness can execute.

A test config typically looks like the following:

```javascript
{
  name: The name that describes this test config, defaults to '<integration> (<branch>) - <framework>',
  integration: The name of the integration, which should be the same as its npm package name,
  repo: A link to the git repositry that contains the source and tests of the integration,
  branch: The name of the branch you want to run the tests on, defaults to 'master',
  env: {
    Any environment key-value pairs you want to pass along to the test runner
  },
  framework: The test runner used by the integration to run its tests,
  args: If framework is not 'custom', any CLI arguments you want to pass to the test runner--which are typically the tests files to run,
  execTests: function (tracerSetupPath, options) {
    If framework is custom, you must set define this function. This function will then be responsible for
    executing the test runner and injecting the tracer setup script located in 'tracerSetupPath'. The
    'options' parameter contains the cwd and other info that you should pass to any execSyncs or execs.
  },
  setup: function (tracerSetupPath, options) {
    A function that allows you to do any preliminary tasks before the test harness executes the test config,
    defaults to just running 'npm install'.
  }
}
```

## Supported test frameworks:

Currently, we support the following test frameworks:

1. [mocha][0]
2. [tap][1]
3. [tape][2]
4. [lab][3]
5. [buster-test][4]
6. [jasmine-node][5]
7. [promises-aplus-tests][6]
8. Any custom frameworks that use the `node` binary to execute test runners

## Examples

Most of the time, writing a test config is just copy pasting a couple of lines from a `package.json`.

### Simple test frameworks:

For integrations that use a supported test framework, our test config is pretty simple. Let's use `redis` as an example:

```javascript
const testConfigs = [
  {
    integration: 'redis',
    repo: 'https://github.com/NodeRedis/node_redis',
    framework: 'mocha',
    args: './test/*.js ./test/commands/*.js --timeout 8000'
  }
]

module.exports = testConfigs
```

If you take a look at `redis`'s [`package.json`][7], you can see that we just had to copy the command `npm test` executes into `framework` and `args`.

### Multiple test configs:

If you need multiple test configs, e.g. to test multiple branches or different test frameworks, you may want to use the `normalizeTestConfigs` helper funcion to simplify your test configs. We can define a set of defaults that will be applied to each test config, unless it's already defined in test config:

```javascript
const normalizeTestConfigs = require('../../../scripts/helpers/normalizeTestConfigs')

const defaults = {
  integration: 'express',
  repo: 'https://github.com/expressjs/express',
  framework: 'mocha',
  args: '--require test/support/env --reporter spec --check-leaks test/ test/acceptance/'
}

const testConfigs = [
  {
    branch: '4.x'
  },
  {
    branch: '5.x'
  },
  {
    branch: 'master'
  }
]

module.exports = normalizeTestConfigs(testConfigs, defaults)
```

In this case, we want to test multiple branches but the way we test each branch remains the same. Therefore, we only need to set the defaults once but change the branch for each test config.

### Using a setup function:

In certain cases, the integration requires building it before you can run tests on it. To solve this problem, you can supply your own `setup` function that will be executed before the tests are run. You can also use this function to move files around if necessary.

 ```javascript
const testConfigs = [
  {
    integration: 'promise',
    repo: 'https://github.com/then/promise',
    setup: function (tracerSetupPath, options) {
      execSync('npm install && npm build', options)
    }
  }
]
```

### Custom test frameworks:

Rarely, projects use their own test runner. In these cases, you should investigate ways on running our tracer setup script before the tests run. For example, the custom test runner for `mongodb-core` requires us pass the tracer setup script as a test to the runner before any of the other tests:

```javascript
const execSync = require('child_process').execSync

const testConfigs = [
  {
    integration: 'mongodb-core',
    repo: 'https://github.com/mongodb-js/mongodb-core',
    framework: 'custom',
    execTests: function (tracerSetupPath, options) {
      execSync(`npm run env -- mongodb-test-runner -t 60000 '${tracerSetupPath}' test/tests`, options)
    }
  }
]

module.exports = testConfigs
```

We use `npm run env -- <command>` before we execute the test runner so that any environment variables and paths are correctly set and passed to the test runner.

## Ran into an issue?

Don't worry, let us know in your PR and we can help out!

[0]: https://www.npmjs.com/package/mocha
[1]: https://www.npmjs.com/package/tap
[2]: https://www.npmjs.com/package/tape
[3]: https://www.npmjs.com/package/lab
[4]: https://www.npmjs.com/package/buster-test
[5]: https://www.npmjs.com/package/jasmine-node
[6]: https://www.npmjs.com/package/promises-aplus-tests
[7]: https://github.com/NodeRedis/node_redis/blob/master/package.json
