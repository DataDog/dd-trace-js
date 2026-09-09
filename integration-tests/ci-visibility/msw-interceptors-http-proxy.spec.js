'use strict'

const path = require('node:path')

const { sandboxCwd, spawnProcAndExpectExit, useSandbox } = require('../helpers')

describe('@mswjs/interceptors HTTP proxy compatibility', () => {
  let cwd

  useSandbox(
    ['@mswjs/interceptors@0.16.6', 'headers-polyfill@3.0.10'],
    false,
    ['./integration-tests/ci-visibility/msw-interceptors-http-proxy']
  )

  before(() => {
    cwd = sandboxCwd()
  })

  it('intercepts an authenticated HTTPS exporter request through an HTTP proxy', () => {
    const app = path.join(cwd, 'msw-interceptors-http-proxy', 'app.js')

    return spawnProcAndExpectExit(app, {
      cwd,
      env: {
        ...process.env,
        ALL_PROXY: '',
        HTTPS_PROXY: 'http://proxy.example:8202',
        NO_PROXY: '',
        all_proxy: '',
        https_proxy: '',
        no_proxy: '',
        npm_config_https_proxy: '',
        npm_config_proxy: '',
      },
    })
  })
})
