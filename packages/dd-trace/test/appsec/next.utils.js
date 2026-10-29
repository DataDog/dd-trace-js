'use strict'

const { execFileSync, spawn } = require('node:child_process')
const { mkdirSync, rmSync, unlinkSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const { satisfies } = require('semver')

const { BUN, BUN_CONFIG } = require('../../../../integration-tests/helpers/bun')
const agent = require('../plugins/agent')

function initApp (appName, version, realVersion) {
  const satisfiesStandalone = version => satisfies(version, '>=12.0.0')

  const appDir = path.join(__dirname, 'next', appName)

  before(async function () {
    this.timeout(300 * 1000) // Webpack is very slow and builds on every test run

    const cwd = appDir

    const pkg = require(`../../../../versions/next@${version}/package.json`)

    delete pkg.workspaces

    writeFileSync(`${appDir}/package.json`, JSON.stringify(pkg, null, 2))

    // Install a standalone tree because copying node_modules from versions does not generate the server files.
    const installArguments = [`--config=${BUN_CONFIG}`, 'install', '--linker=hoisted', '--trust']
    try {
      execFileSync(BUN, installArguments, { cwd })
    } catch { // retry in case of error from registry
      execFileSync(BUN, installArguments, { cwd })
    }

    // building in-process makes tests fail for an unknown reason
    const legacyOpenssl = satisfies(realVersion, '<12') ? '--openssl-legacy-provider' : ''
    execFileSync(BUN, ['run', 'next', 'build'], {
      cwd,
      env: {
        ...process.env,
        NODE_OPTIONS: legacyOpenssl,
        version,
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    if (satisfiesStandalone(realVersion)) {
      // copy public and static files to the `standalone` folder
      // const publicOrigin = `${appDir}/public`
      const publicDestination = `${appDir}/.next/standalone/public`

      mkdirSync(publicDestination)
    }
  })

  after(function () {
    this.timeout(5000)

    const files = [
      'package.json',
      'bun.lock',
    ]
    const filePaths = files.map(file => `${appDir}/${file}`)
    filePaths.forEach(path => {
      unlinkSync(path)
    })

    const dirs = [
      'node_modules',
      '.next',
    ]
    const dirPaths = dirs.map(file => `${appDir}/${file}`)
    dirPaths.forEach(path => {
      rmSync(path, { recursive: true, force: true })
    })
  })
}

function startServer (appName, serverPath, version, ddInitFile = 'datadog.js') {
  const result = {}
  let server

  const appDir = path.join(__dirname, 'next', appName)
  const schemaVersion = 'v0'
  const defaultToGlobalService = 'false'

  before(async () => {
    return agent.load('next')
  })

  before(function (done) {
    this.timeout(300 * 1000)
    const cwd = appDir

    server = spawn('node', [serverPath], {
      cwd,
      env: {
        ...process.env,
        VERSION: version,
        PORT: '0',
        DD_TRACE_AGENT_PORT: agent.server.address().port,
        DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: schemaVersion,
        DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: defaultToGlobalService,
        NODE_OPTIONS: `--require ${appDir}/${ddInitFile}`,
        HOSTNAME: '127.0.0.1',
      },
    })

    server.once('error', done)

    function waitUntilServerStarted (chunk) {
      const chunkStr = chunk.toString()
      const match = chunkStr.match(/port:? (\d+)/) ||
          chunkStr.match(/http:\/\/127\.0\.0\.1:(\d+)/)

      if (match) {
        result.port = Number(match[1])
        server.stdout.off('data', waitUntilServerStarted)
        done()
      }
    }
    server.stdout.on('data', waitUntilServerStarted)

    server.stderr.on('data', chunk => process.stderr.write(chunk))
    server.stdout.on('data', chunk => process.stdout.write(chunk))
  })

  after(async function () {
    this.timeout(5000)

    server.kill()

    await agent.close()
  })

  return result
}

module.exports = {
  initApp, startServer,
}
