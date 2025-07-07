'use strict'

const { spawn, execSync } = require('child_process')
const { cpSync, mkdirSync, rmdirSync, unlinkSync } = require('fs')
const axios = require('axios')
const { writeFileSync } = require('fs')
const { satisfies } = require('semver')
const path = require('path')

const agent = require('../plugins/agent')
const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../../../version')

describe('test suite', () => {
  let server
  let port

  const satisfiesStandalone = version => satisfies(version, '>=12.0.0')

  withVersions('next', 'next', '>=11.1', version => {
    if (version === '>=11.0.0 <13' && NODE_MAJOR === 24 &&
      NODE_MINOR === 0 && NODE_PATCH === 0) {
      return // node 24.0.0 fails, but 24.0.1 works
    }

    const realVersion = require(`../../../../versions/next@${version}`).version()

    function initApp (appName) {
      const appDir = path.join(__dirname, 'next', appName)

      before(async function () {
        this.timeout(300 * 1000) // Webpack is very slow and builds on every test run

        const cwd = appDir

        const pkg = require(`../../../../versions/next@${version}/package.json`)

        if (realVersion.startsWith('10')) {
          return this.skip() // TODO: Figure out why 10.x tests fail.
        }
        delete pkg.workspaces

        // builds fail for next.js 9.5 using node 14 due to webpack issues
        // note that webpack version cannot be set in v9.5 in next.config.js so we do it here instead
        // the link below highlights the initial support for webpack 5 (used to fix this issue) in next.js 9.5
        // https://nextjs.org/blog/next-9-5#webpack-5-support-beta
        if (realVersion.startsWith('9')) pkg.resolutions = { webpack: '^5.0.0' }

        writeFileSync(`${appDir}/package.json`, JSON.stringify(pkg, null, 2))

        // installing here for standalone purposes, copying `nodules` above was not generating the server file properly
        // if there is a way to re-use nodules from somewhere in the versions folder, this `execSync` will be reverted
        try {
          execSync('yarn install', { cwd })
        } catch (e) { // retry in case of error from registry
          execSync('yarn install', { cwd })
        }

        // building in-process makes tests fail for an unknown reason
        execSync('NODE_OPTIONS=--openssl-legacy-provider yarn exec next build', {
          cwd,
          env: {
            ...process.env,
            version
          },
          stdio: ['pipe', 'ignore', 'pipe']
        })

        if (satisfiesStandalone(realVersion)) {
          // copy public and static files to the `standalone` folder
          // const publicOrigin = `${appDir}/public`
          const publicDestination = `${appDir}/.next/standalone/public`
          const rulesFileOrigin = `${appDir}/appsec-rules.json`
          const rulesFileDestination = `${appDir}/.next/standalone/appsec-rules.json`

          mkdirSync(publicDestination)
          cpSync(rulesFileOrigin, rulesFileDestination)
        }
      })

      after(function () {
        this.timeout(5000)

        const files = [
          'package.json',
          'yarn.lock'
        ]
        const filePaths = files.map(file => `${appDir}/${file}`)
        filePaths.forEach(path => {
          unlinkSync(path)
        })

        const dirs = [
          'node_modules',
          '.next'
        ]
        const dirPaths = dirs.map(file => `${appDir}/${file}`)
        dirPaths.forEach(path => {
          rmdirSync(path, { recursive: true, force: true })
        })
      })
    }

    const startServer = ({ appName, serverPath }, schemaVersion = 'v0', defaultToGlobalService = false) => {
      const appDir = path.join(__dirname, 'next', appName)

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
            PORT: 0,
            DD_TRACE_AGENT_PORT: agent.server.address().port,
            DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: schemaVersion,
            DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: defaultToGlobalService,
            NODE_OPTIONS: `--require ${appDir}/datadog.js`,
            HOSTNAME: '127.0.0.1'
          }
        })

        server.once('error', done)

        function waitUntilServerStarted (chunk) {
          port = Number(chunk.toString().match(/port: (\d+)/)?.[1])

          if (port) {
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

        await agent.close({ ritmReset: false })
      })
    }

    const tests = [
      {
        appName: 'pages-dir',
        serverPath: 'server'
      }
    ]

    if (satisfies(realVersion, '>=13.2') && (NODE_MAJOR < 24 || satisfies(realVersion, '!=13.2'))) {
      tests.push({
        appName: 'app-dir',
        serverPath: '.next/standalone/server.js'
      })
    }

    function getFindBodyThreatMethod (done) {
      return function findBodyThreat (traces) {
        let attackFound = false

        traces.forEach(trace => {
          trace.forEach(span => {
            if (span.meta['_dd.appsec.json']) {
              attackFound = true
            }
          })
        })

        if (attackFound) {
          agent.unsubscribe(findBodyThreat)
          done()
        }
      }
    }

    tests.forEach(({ appName, serverPath }) => {
      describe(`should detect threats in ${appName}`, () => {
        initApp(appName)

        startServer({ appName, serverPath })

        it('in request body', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          agent.subscribe(findBodyThreat)
          axios
            .post(`http://127.0.0.1:${port}/api/test`, {
              key: 'testattack'
            }).catch(e => { done(e) })
        })

        it('in form data body', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          agent.subscribe(findBodyThreat)

          axios
            .post(`http://127.0.0.1:${port}/api/test-formdata`, new URLSearchParams({
              key: 'testattack'
            })).catch(e => {
              done(e)
            })
        })

        if (appName === 'app-dir') {
          it('in request body with .text() function', function (done) {
            this.timeout(5000)

            const findBodyThreat = getFindBodyThreatMethod(done)
            agent.subscribe(findBodyThreat)
            axios
              .post(`http://127.0.0.1:${port}/api/test-text`, {
                key: 'testattack'
              }).catch(e => {
                done(e)
              })
          })
        }

        it('in request query', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          axios
            .get(`http://127.0.0.1:${port}/api/test?param=testattack`)
            .catch(e => { done(e) })

          agent.subscribe(findBodyThreat)
        })

        it('in request query with array params, attack in the second  item', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          axios
            .get(`http://127.0.0.1:${port}/api/test?param[]=safe&param[]=testattack`)
            .catch(e => { done(e) })

          agent.subscribe(findBodyThreat)
        })

        it('in request query with array params, threat in the first item', function (done) {
          this.timeout(5000)

          const findBodyThreat = getFindBodyThreatMethod(done)

          axios
            .get(`http://127.0.0.1:${port}/api/test?param[]=testattack&param[]=safe`)
            .catch(e => { done(e) })

          agent.subscribe(findBodyThreat)
        })
      })
    })
  })
})
