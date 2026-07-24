'use strict'

exports.config = {
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
