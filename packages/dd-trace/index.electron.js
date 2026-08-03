'use strict'

// Must never require './src/register-features' (or anything that transitively reaches it) -
// doing so would make @datadog/native-iast-taint-tracking and @datadog/wasm-js-rewriter
// reachable again in Electron webpack bundles (see
// integration-tests/webpack/build-and-test-electron.js).
module.exports = require('./src/bootstrap')
