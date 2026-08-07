'use strict'

// Must never require the optional-feature registration files (openfeature/register,
// appsec/register, appsec/iast/register, appsec/iast/taint-tracking/register), or anything
// that transitively reaches them - doing so would make @datadog/native-iast-taint-tracking
// and @datadog/wasm-js-rewriter reachable again in Electron webpack bundles (see
// integration-tests/webpack/build-and-test-electron.js).
module.exports = require('./src/bootstrap')
