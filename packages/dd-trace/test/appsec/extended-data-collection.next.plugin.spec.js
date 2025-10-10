'use strict'

const { spawn, execSync } = require('child_process')
const { mkdirSync, rmSync, unlinkSync } = require('fs')
const axios = require('axios')
const { writeFileSync } = require('fs')
const { satisfies } = require('semver')
const path = require('path')
const assert = require('assert')
const msgpack = require('@msgpack/msgpack')

const agent = require('../plugins/agent')
const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../../../version')
const { withVersions } = require('../setup/mocha')

function findWebSpan (traces) {
  for (const trace of traces) {
    for (const span of trace) {
      if (span.type === 'web') {
        return span
      }
    }
  }
  throw new Error('web span not found')
}

function createDeepObject (sheetValue, currentLevel = 1, max = 20) {
  if (currentLevel === max) {
    return {
      [`s-${currentLevel}`]: `s-${currentLevel}`,
      [`o-${currentLevel}`]: sheetValue
    }
  }

  return {
    [`s-${currentLevel}`]: `s-${currentLevel}`,
    [`o-${currentLevel}`]: createDeepObject(sheetValue, currentLevel + 1, max)
  }
}

describe('extended data collection', () => {
  let server
  let port

  const satisfiesStandalone = version => satisfies(version, '>=12.0.0')

  withVersions('next', 'next', '>=11.1', version => {
    if (version === '>=11.0.0 <13' && NODE_MAJOR === 24 &&
      NODE_MINOR === 0 && NODE_PATCH === 0) {
      // node 24.0.0 fails, but 24.0.1 works
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
          const publicDestination = path.join(appDir, '.next/standalone/public')

          mkdirSync(publicDestination)
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
          rmSync(path, { recursive: true, force: true })
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
            NODE_OPTIONS: `--require ${appDir}/datadog-extended-data-collection.js`,
            HOSTNAME: '127.0.0.1'
          }
        })

        server.once('error', done)

        function waitUntilServerStarted (chunk) {
          const chunkStr = chunk.toString()
          const match = chunkStr.match(/port:? (\d+)/) ||
              chunkStr.match(/http:\/\/127\.0\.0\.1:(\d+)/)

          if (match) {
            port = Number(match[1])
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

    tests.forEach(({ appName, serverPath }) => {
      describe(`extended data collection in ${appName}`, () => {
        initApp(appName)

        startServer({ appName, serverPath })

        it('Should collect nothing when no extended_data_collection is triggered', async () => {
          const requestBody = {
            other: 'other',
            chained: {
              child: 'one',
              child2: 2
            }
          }

          await axios.post(
            `http://127.0.0.1:${port}/api/extended-data-collection`,
            requestBody,
            {
              headers: {
                'custom-header-key-1': 'custom-header-value-1',
                'custom-header-key-2': 'custom-header-value-2',
                'custom-header-key-3': 'custom-header-value-3'
              }
            }
          )

          await agent.assertSomeTraces((traces) => {
            const span = findWebSpan(traces)

            assert.strictEqual(span.meta['http.request.headers.custom-request-header-1'], undefined)
            assert.strictEqual(span.meta['http.request.headers.custom-request-header-2'], undefined)
            assert.strictEqual(span.meta['http.request.headers.custom-request-header-3'], undefined)

            assert.strictEqual(span.meta['http.response.headers.custom-response-header-1'], undefined)
            assert.strictEqual(span.meta['http.response.headers.custom-response-header-2'], undefined)
            assert.strictEqual(span.meta['http.response.headers.custom-response-header-3'], undefined)

            const rawMetaStructBody = span.meta_struct?.['http.request.body']
            assert.strictEqual(rawMetaStructBody, undefined)
          })
        })

        it('Should redact request/response headers', async () => {
          const requestBody = {
            bodyParam: 'collect-standard'
          }
          await axios.post(
            `http://127.0.0.1:${port}/api/extended-data-collection/redacted-headers`,
            requestBody,
            {
              headers: {
                authorization: 'header-value-1',
                'proxy-authorization': 'header-value-2',
                'www-authenticate': 'header-value-3',
                'proxy-authenticate': 'header-value-4',
                'authentication-info': 'header-value-5',
                'proxy-authentication-info': 'header-value-6',
                cookie: 'header-value-7',
                'set-cookie': 'header-value-8'
              }
            }
          )

          await agent.assertSomeTraces((traces) => {
            const span = findWebSpan(traces)

            assert.strictEqual(span.meta['http.request.headers.authorization'], '<redacted>')
            assert.strictEqual(span.meta['http.request.headers.proxy-authorization'], '<redacted>')
            assert.strictEqual(span.meta['http.request.headers.www-authenticate'], '<redacted>')
            assert.strictEqual(span.meta['http.request.headers.proxy-authenticate'], '<redacted>')
            assert.strictEqual(span.meta['http.request.headers.authentication-info'], '<redacted>')
            assert.strictEqual(span.meta['http.request.headers.proxy-authentication-info'], '<redacted>')
            assert.strictEqual(span.meta['http.request.headers.cookie'], '<redacted>')
            assert.strictEqual(span.meta['http.request.headers.set-cookie'], '<redacted>')

            assert.strictEqual(span.meta['http.response.headers.authorization'], '<redacted>')
            assert.strictEqual(span.meta['http.response.headers.proxy-authorization'], '<redacted>')
            assert.strictEqual(span.meta['http.response.headers.www-authenticate'], '<redacted>')
            assert.strictEqual(span.meta['http.response.headers.proxy-authenticate'], '<redacted>')
            assert.strictEqual(span.meta['http.response.headers.authentication-info'], '<redacted>')
            assert.strictEqual(span.meta['http.response.headers.proxy-authentication-info'], '<redacted>')
            assert.strictEqual(span.meta['http.response.headers.cookie'], '<redacted>')
            assert.strictEqual(span.meta['http.response.headers.set-cookie'], '<redacted>')
          })
        })

        it('Should collect request body and request/response with a max of 8 headers', async () => {
          const requestBody = {
            bodyParam: 'collect-few-headers',
            other: 'other',
            chained: {
              child: 'one',
              child2: 2
            }
          }
          await axios.post(
            `http://127.0.0.1:${port}/api/extended-data-collection`,
            requestBody,
            {
              headers: {
                'custom-request-header-1': 'custom-request-header-value-1',
                'custom-request-header-2': 'custom-request-header-value-2',
                'custom-request-header-3': 'custom-request-header-value-3',
                'custom-request-header-4': 'custom-request-header-value-4',
                'custom-request-header-5': 'custom-request-header-value-5',
                'custom-request-header-6': 'custom-request-header-value-6',
                'custom-request-header-7': 'custom-request-header-value-7',
                'custom-request-header-8': 'custom-request-header-value-8',
                'custom-request-header-9': 'custom-request-header-value-9',
                'custom-request-header-10': 'custom-request-header-value-10'
              }
            }
          )

          await agent.assertSomeTraces((traces) => {
            const span = findWebSpan(traces)

            const collectedRequestHeaders = Object.keys(span.meta)
              .filter(metaKey => metaKey.startsWith('http.request.headers.')).length
            const collectedResponseHeaders = Object.keys(span.meta)
              .filter(metaKey => metaKey.startsWith('http.response.headers.')).length
            assert.strictEqual(collectedRequestHeaders, 8)
            assert.strictEqual(collectedResponseHeaders, 8)

            assert.ok(span.metrics['_dd.appsec.request.header_collection.discarded'] >= 2)
            assert.ok(span.metrics['_dd.appsec.response.header_collection.discarded'] >= 2)

            const metaStructBody = msgpack.decode(span.meta_struct['http.request.body'])
            assert.deepEqual(metaStructBody, requestBody)
          })
        })

        it('Should truncate the request body when depth is more than 20 levels', async () => {
          const deepObject = createDeepObject('sheet')

          const requestBody = {
            bodyParam: 'collect-standard',
            deepObject
          }

          const expectedDeepTruncatedObject = createDeepObject({ 's-19': 's-19' }, 1, 18)
          const expectedRequestBody = {
            bodyParam: 'collect-standard',
            deepObject: expectedDeepTruncatedObject
          }
          await axios.post(`http://127.0.0.1:${port}/api/extended-data-collection`, requestBody)

          await agent.assertSomeTraces((traces) => {
            const span = findWebSpan(traces)

            const metaStructBody = msgpack.decode(span.meta_struct['http.request.body'])
            assert.deepEqual(metaStructBody, expectedRequestBody)
          })
        })

        it('Should truncate the request body when string length is more than 4096 characters', async () => {
          const requestBody = {
            bodyParam: 'collect-standard',
            longValue: Array(5000).fill('A').join('')
          }

          const expectedRequestBody = {
            bodyParam: 'collect-standard',
            longValue: Array(4096).fill('A').join('')
          }
          await axios.post(`http://127.0.0.1:${port}/api/extended-data-collection`, requestBody)

          await agent.assertSomeTraces((traces) => {
            const span = findWebSpan(traces)

            const metaStructBody = msgpack.decode(span.meta_struct['http.request.body'])
            assert.deepEqual(metaStructBody, expectedRequestBody)
          })
        })

        it('Should truncate the request body when a node has more than 256 elements', async () => {
          const children = Array(300).fill('item')
          const requestBody = {
            bodyParam: 'collect-standard',
            children
          }

          const expectedRequestBody = {
            bodyParam: 'collect-standard',
            children: children.slice(0, 256)
          }
          await axios.post(`http://127.0.0.1:${port}/api/extended-data-collection`, requestBody)

          await agent.assertSomeTraces((traces) => {
            const span = findWebSpan(traces)

            const metaStructBody = msgpack.decode(span.meta_struct['http.request.body'])
            assert.deepEqual(metaStructBody, expectedRequestBody)
          })
        })
      })
    })
  })
})
