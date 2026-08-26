'use strict'

const scenario = process.env.WEBDRIVERIO_SCENARIO || 'parallel'
const framework = process.env.WEBDRIVERIO_FRAMEWORK || 'mocha'

const baseConfig = {
  runner: 'local',
  specs: [
    './first.e2e.js',
    './second.e2e.js',
  ],
  maxInstances: 2,
  capabilities: [{
    browserName: 'chrome',
  }],
  protocol: 'http',
  hostname: '127.0.0.1',
  port: Number(process.env.WEBDRIVER_PORT),
  path: '/',
  connectionRetryCount: 0,
  services: [],
  framework,
  reporters: [],
  jasmineOpts: {
    defaultTimeoutInterval: 10_000,
    random: false,
  },
  mochaOpts: {
    ui: 'bdd',
    timeout: 10_000,
  },
}

const scenarioConfig = {
  automaticLogSubmission: {
    after () {
      require('bunyan').createLogger({ name: 'after-hook-logger' }).info('Hello from WebdriverIO after hook!')
    },
    maxInstances: 1,
    specs: ['./automatic-log-submission.e2e.js'],
  },
  atr: {
    maxInstances: 1,
    specs: ['./atr.e2e.js'],
  },
  atrAlwaysFails: {
    maxInstances: 1,
    specs: ['./atr-always-fail.e2e.js'],
  },
  atrHookFailures: {
    maxInstances: 1,
    specs: ['./atr-hook-fail.e2e.js'],
  },
  bail: {
    maxInstances: 1,
    mochaOpts: {
      bail: true,
    },
    specs: [[
      './fail.e2e.js',
      './second.e2e.js',
    ]],
  },
  preFrameworkFailure: {
    maxInstances: 1,
    reporters: ['webdriverio-missing-reporter'],
    specs: ['./first.e2e.js'],
  },
  delay: {
    maxInstances: 1,
    mochaOpts: {
      delay: true,
    },
    specs: ['./delay.e2e.js'],
  },
  disabledEfd: {
    maxInstances: 1,
    specs: [[
      './impacted.e2e.js',
      './disabled-efd.e2e.js',
      './first.e2e.js',
    ]],
  },
  efd: {
    maxInstances: 1,
    specs: ['./efd.e2e.js'],
  },
  efdFailedTestReplay: {
    maxInstances: 1,
    specs: ['./efd-failed-test-replay.e2e.js'],
  },
  efdAfterEachFailure: {
    maxInstances: 1,
    specs: ['./efd-after-each-fail.e2e.js'],
  },
  efdFaultySchedule: {
    maxInstances: 1,
    specs: [
      [
        './first.e2e.js',
        './efd.e2e.js',
      ],
      './second.e2e.js',
    ],
  },
  failedTestReplay: {
    maxInstances: 1,
    specs: ['./failed-test-replay.e2e.js'],
  },
  grep: {
    maxInstances: 1,
    mochaOpts: {
      grep: 'first worker',
    },
    specs: [[
      './first.e2e.js',
      './second.e2e.js',
    ]],
  },
  grouped: {
    maxInstances: 1,
    specs: [[
      './first.e2e.js',
      './second.e2e.js',
    ]],
  },
  groupedEmpty: {
    maxInstances: 1,
    specs: [[
      './empty.e2e.js',
      './first.e2e.js',
    ]],
  },
  hookFailure: {
    maxInstances: 1,
    specs: [[
      './hook-fail.e2e.js',
      './first.e2e.js',
    ]],
  },
  impacted: {
    maxInstances: 1,
    specs: [[
      './impacted.e2e.js',
      './first.e2e.js',
    ]],
  },
  jasmineStatuses: {
    maxInstances: 1,
    specs: ['./jasmine-statuses.e2e.js'],
  },
  jasmineAfterAllFailure: {
    maxInstances: 1,
    specs: ['./jasmine-after-all-fail.e2e.js'],
  },
  jasmineAttemptToFixSkipped: {
    maxInstances: 1,
    specs: ['./jasmine-attempt-to-fix-skipped.e2e.js'],
  },
  jasmineDelayedSettings: {
    maxInstances: 1,
    specs: ['./first.e2e.js'],
  },
  jasmineEfdSkipped: {
    maxInstances: 1,
    specs: ['./jasmine-efd-skipped.e2e.js'],
  },
  jasmineExpectationHookFailures: {
    maxInstances: 1,
    specs: ['./jasmine-expectation-hook-fail.e2e.js'],
  },
  jasmineFiltered: {
    jasmineOpts: {
      grep: 'runs selected test',
    },
    maxInstances: 1,
    specs: ['./jasmine-filtered.e2e.js'],
  },
  jasmineGlobalAfterAllFailure: {
    maxInstances: 1,
    specs: [[
      './jasmine-global-after-all-fail.e2e.js',
      './first.e2e.js',
    ]],
  },
  jasmineHooks: {
    maxInstances: 1,
    specs: ['./jasmine-hooks.e2e.js'],
  },
  jasmineNoExpectations: {
    jasmineOpts: {
      failSpecWithNoExpectations: true,
    },
    maxInstances: 1,
    specs: ['./jasmine-no-expectations.e2e.js'],
  },
  jasmineRetry: {
    maxInstances: 1,
    specs: ['./jasmine-retry.e2e.js'],
  },
  loadFailure: {
    maxInstances: 1,
    specs: ['./load-fail.e2e.js'],
  },
  managedHookFailures: {
    maxInstances: 1,
    specs: ['./managed-hook-fail.e2e.js'],
  },
  multipleCapabilities: {
    capabilities: [
      { browserName: 'chrome' },
      { browserName: 'firefox' },
    ],
    specs: ['./first.e2e.js'],
  },
  parallel: {},
  retries: {
    maxInstances: 1,
    mochaOpts: {
      retries: 1,
    },
    specs: ['./retry.e2e.js'],
  },
  runnerEnvNodeOptions: {
    maxInstances: 1,
    runnerEnv: {
      NODE_OPTIONS: '--require ./runner-env-preload.js',
    },
    specs: ['./runner-env.e2e.js'],
  },
  serial: {
    maxInstances: 1,
  },
  specFileRetries: {
    maxInstances: 1,
    specFileRetries: 1,
    specFileRetriesDelay: 0,
    specs: ['./spec-file-retry.e2e.js'],
  },
  suiteHookFailure: {
    maxInstances: 1,
    specs: ['./suite-hook-fail.e2e.js'],
  },
  tdd: {
    maxInstances: 1,
    mochaOpts: {
      ui: 'tdd',
    },
    specs: ['./tdd.e2e.js'],
  },
  testManagement: {
    maxInstances: 1,
    specs: ['./test-management.e2e.js'],
  },
  testManagementDisabledHook: {
    maxInstances: 1,
    specs: ['./test-management-disabled-hook.e2e.js'],
  },
}

const selectedScenario = scenarioConfig[scenario]
if (!selectedScenario) {
  throw new Error(`Unknown WebdriverIO integration scenario: ${scenario}`)
}

exports.config = {
  ...baseConfig,
  ...selectedScenario,
  jasmineOpts: {
    ...baseConfig.jasmineOpts,
    ...selectedScenario.jasmineOpts,
  },
  mochaOpts: {
    ...baseConfig.mochaOpts,
    ...selectedScenario.mochaOpts,
  },
}
