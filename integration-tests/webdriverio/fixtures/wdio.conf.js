'use strict'

const scenario = process.env.WEBDRIVERIO_SCENARIO || 'parallel'

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
  framework: 'mocha',
  reporters: [],
  mochaOpts: {
    ui: 'bdd',
    timeout: 10_000,
  },
}

const scenarioConfig = {
  atr: {
    maxInstances: 1,
    specs: ['./atr.e2e.js'],
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
  efd: {
    maxInstances: 1,
    specs: ['./efd.e2e.js'],
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
  hookFailure: {
    maxInstances: 1,
    specs: [[
      './hook-fail.e2e.js',
      './first.e2e.js',
    ]],
  },
  impacted: {
    maxInstances: 1,
    specs: ['./impacted.e2e.js'],
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
}

const selectedScenario = scenarioConfig[scenario]
if (!selectedScenario) {
  throw new Error(`Unknown WebdriverIO integration scenario: ${scenario}`)
}

exports.config = {
  ...baseConfig,
  ...selectedScenario,
  mochaOpts: {
    ...baseConfig.mochaOpts,
    ...selectedScenario.mochaOpts,
  },
}
