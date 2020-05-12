// Karma configuration
// Generated on Tue Sep 17 2019 19:39:09 GMT-0400 (EDT)

const webpackConfig = require('./webpack.config')

module.exports = function (config) {
  const opts = {

    // base path that will be used to resolve all patterns (eg. files, exclude)
    basePath: '',

    // frameworks to use
    // available frameworks: https://npmjs.org/browse/keyword/karma-adapter
    frameworks: ['mocha'],

    // list of files / patterns to load in the browser
    files: [
      'browser.js',
      'packages/dd-trace/test/setup/browser.js',
      'packages/dd-trace/test/browser.test.js'
    ],

    // list of files / patterns to exclude
    exclude: [],

    // preprocess matching files before serving them to the browser
    // available preprocessors: https://npmjs.org/browse/keyword/karma-preprocessor
    preprocessors: {
      'browser.js': ['webpack'],
      'packages/dd-trace/test/setup/browser.js': ['webpack'],
      'packages/dd-trace/test/browser.test.js': ['webpack']
    },

    // test results reporter to use
    // possible values: 'dots', 'progress'
    // available reporters: https://npmjs.org/browse/keyword/karma-reporter
    reporters: ['progress'],

    // web server port
    port: 9876,

    // enable / disable colors in the output (reporters and logs)
    colors: true,

    // level of logging
    // possible values: config.LOG_DISABLE || config.LOG_ERROR || config.LOG_WARN || config.LOG_INFO || config.LOG_DEBUG
    logLevel: config.LOG_INFO,

    // enable / disable watching file and executing tests whenever any file changes
    autoWatch: true,

    // start these browsers
    // available browser launchers: https://npmjs.org/browse/keyword/karma-launcher
    browsers: ['ChromeHeadless', 'FirefoxHeadless'],

    // Continuous Integration mode
    // if true, Karma captures browsers, runs the tests and exits
    singleRun: false,

    // Concurrency level
    // how many browser should be started simultaneous
    concurrency: Infinity,

    webpack: webpackConfig.find(entry => entry.mode === 'development')
  }

  if (process.env.BROWSERSTACK === 'true') {
    // https://github.com/karma-runner/karma-browserstack-launcher
    opts.browserStack = {
      project: 'dd-trace-js'
    }

    opts.customLaunchers = {
      bs_edge: {
        base: 'BrowserStack',
        browser: 'Edge',
        browser_version: '18.0',
        os: 'Windows',
        os_version: '10'
      },

      bs_ie11: {
        base: 'BrowserStack',
        browser: 'IE',
        browser_version: '11.0',
        os: 'Windows',
        os_version: '10'
      },

      bs_ie10: {
        base: 'BrowserStack',
        browser: 'IE',
        browser_version: '10.0',
        os: 'Windows',
        os_version: '8'
      },

      bs_safari: {
        base: 'BrowserStack',
        browser: 'Safari',
        browser_version: '12.0',
        os: 'OS X',
        os_version: 'Mojave'
      }
    }

    opts.reporters = ['BrowserStack']

    for (const browser in opts.customLaunchers) {
      opts.browsers.push(browser)
    }
  }

  config.set(opts)
}
