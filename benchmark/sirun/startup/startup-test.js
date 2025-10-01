'use strict'

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

if (Number(process.env.EVERYTHING)) {
  // TODO: Add a preparation step that installs these dependencies. That way we
  // are independent from what is currently installed in case adependency is
  // removed.
  const packages = [
    '@babel/helpers',
    '@datadog/libdatadog',
    '@datadog/native-appsec',
    '@datadog/native-iast-taint-tracking',
    '@datadog/native-metrics',
    '@datadog/pprof',
    '@datadog/sketches-js',
    '@datadog/wasm-js-rewriter',
    '@eslint/eslintrc',
    '@eslint/js',
    '@isaacs/ttlcache',
    '@msgpack/msgpack',
    '@opentelemetry/api',
    '@opentelemetry/core',
    '@stylistic/eslint-plugin',
    'axios',
    'benchmark',
    'body-parser',
    'chai',
    'crypto-randomuuid',
    'dc-polyfill',
    'eslint-plugin-cypress',
    'eslint-plugin-import',
    'eslint-plugin-mocha',
    'eslint-plugin-n',
    'eslint-plugin-promise',
    'eslint-plugin-unicorn',
    'eslint',
    'express',
    'glob',
    'globals',
    'graphql',
    'ignore',
    'import-in-the-middle',
    'istanbul-lib-coverage',
    'jest-docblock',
    'jsonpath-plus',
    'jszip',
    'limiter',
    'lodash.sortby',
    'lru-cache',
    'mocha',
    'module-details-from-path',
    'multer',
    'mutexify',
    'nock',
    'nyc',
    'octokit',
    'opentracing',
    'path-to-regexp',
    'pprof-format',
    'protobufjs',
    'proxyquire',
    'retry',
    'rfdc',
    'semifies',
    'semver',
    'shell-quote',
    'sinon-chai',
    'sinon',
    'source-map',
    'tap',
    'tiktoken',
    'tlhunter-sorted-set',
    'ttl-set',
    'workerpool',
    'yaml',
    'yarn-deduplicate'
  ]
  for (const pkg of packages) {
    require(pkg)
  }
}
