'use strict'

/* eslint import/no-extraneous-dependencies: ["error", {"packageDir": ['./']}] */

const axios = require('axios')
const getPort = require('get-port')
const { execSync, spawn } = require('child_process')
const agent = require('../../dd-trace/test/plugins/agent')
const { writeFileSync } = require('fs')
const { satisfies } = require('semver')
const { DD_MAJOR } = require('../../../version')
const { rawExpectedSchema } = require('./naming')

describe('Plugin', function () {
  let server
  let port

  describe('next', () => {
    const satisfiesStandalone = version => satisfies(version, '>=12.0.0')

    // TODO: Figure out why 10.x tests are failing.
    withVersions('next', 'next', DD_MAJOR >= 4 && '>=11', version => {
      const pkg = require(`${__dirname}/../../../versions/next@${version}/node_modules/next/package.json`)

      const startServer = ({ withConfig, standalone }, schemaVersion = 'v0', defaultToGlobalService = false) => {
        before(async () => {
          port = await getPort()

          return agent.load('next')
        })

        before(function (done) {
          this.timeout(40000)
          const cwd = standalone
            ? `${__dirname}/.next/standalone`
            : __dirname

          server = spawn('node', ['server'], {
            cwd,
            env: {
              ...process.env,
              VERSION: version,
              PORT: port,
              DD_TRACE_AGENT_PORT: agent.server.address().port,
              WITH_CONFIG: withConfig,
              DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: schemaVersion,
              DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: defaultToGlobalService,
              NODE_OPTIONS: `--require ${__dirname}/datadog.js`,
              HOSTNAME: '127.0.0.1',
              TIMES_HOOK_CALLED: 0
            }
          })

          server.once('error', done)
          server.stdout.once('data', () => {
            // first log outputted isn't always the server started log
            // https://github.com/vercel/next.js/blob/v10.2.0/packages/next/next-server/server/config-utils.ts#L39
            // these are webpack related logs that run during execution time and not build

            // additionally, next.js sets timeouts in 10.x when displaying extra logs
            // https://github.com/vercel/next.js/blob/v10.2.0/packages/next/server/next.ts#L132-L133
            setTimeout(done, 100) // relatively high timeout chosen to be safe
          })
          server.stderr.on('data', chunk => process.stderr.write(chunk))
          server.stdout.on('data', chunk => process.stdout.write(chunk))
        })

        after(async function () {
          this.timeout(5000)

          server.kill()

          await axios.get(`http://127.0.0.1:${port}/api/hello/world`).catch(() => {})
          await agent.close({ ritmReset: false })
        })
      }

      before(async function () {
        this.timeout(120 * 1000) // Webpack is very slow and builds on every test run

        const cwd = __dirname
        const pkg = require(`${__dirname}/../../../versions/next@${version}/package.json`)
        const realVersion = require(`${__dirname}/../../../versions/next@${version}`).version()

        delete pkg.workspaces

        // builds fail for next.js 9.5 using node 14 due to webpack issues
        // note that webpack version cannot be set in v9.5 in next.config.js so we do it here instead
        // the link below highlights the initial support for webpack 5 (used to fix this issue) in next.js 9.5
        // https://nextjs.org/blog/next-9-5#webpack-5-support-beta
        if (realVersion.startsWith('9')) pkg.resolutions = { webpack: '^5.0.0' }

        writeFileSync(`${__dirname}/package.json`, JSON.stringify(pkg, null, 2))

        // installing here for standalone purposes, copying `nodules` above was not generating the server file properly
        // if there is a way to re-use nodules from somewhere in the versions folder, this `execSync` will be reverted
        execSync('yarn install', { cwd })

        // building in-process makes tests fail for an unknown reason
        execSync('yarn exec next build', {
          cwd,
          env: {
            ...process.env,
            version
          },
          stdio: ['pipe', 'ignore', 'pipe']
        })

        if (satisfiesStandalone(realVersion)) {
          // copy public and static files to the `standalone` folder
          const publicOrigin = `${__dirname}/public`
          const publicDestination = `${__dirname}/.next/standalone/public`
          execSync(`mkdir ${publicDestination}`)
          execSync(`cp ${publicOrigin}/test.txt ${publicDestination}/test.txt`)
        }
      })

      after(function () {
        this.timeout(5000)
        const files = [
          'package.json',
          'node_modules',
          '.next',
          'yarn.lock'
        ]
        const paths = files.map(file => `${__dirname}/${file}`)
        execSync(`rm -rf ${paths.join(' ')}`)
      })

      withNamingSchema(
        (done) => {
          axios
            .get(`http://127.0.0.1:${port}/api/hello/world`)
            // skip catch due to socket hang up when server is killed, unsure if this catch is needed
            // .catch(done)
        },
        rawExpectedSchema.server,
        {
          hooks: (schemaVersion, defaultToGlobalService) => startServer({
            withConfig: false,
            standalone: false
          }, schemaVersion, defaultToGlobalService),
          selectSpan: traces => traces[0][1]
        }
      )

      describe('without configuration', () => {
        startServer({ withConfig: false, standalone: false })

        describe('for api routes', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[1]).to.have.property('name', 'next.request')
                expect(spans[1]).to.have.property('service', 'test')
                expect(spans[1]).to.have.property('type', 'web')
                expect(spans[1]).to.have.property('resource', 'GET /api/hello/[name]')
                expect(spans[1].meta).to.have.property('span.kind', 'server')
                expect(spans[1].meta).to.have.property('http.method', 'GET')
                expect(spans[1].meta).to.have.property('http.status_code', '200')
                expect(spans[1].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/hello/world`)
              .catch(done)
          })

          const pathTests = [
            ['/api/hello', '/api/hello'],
            ['/api/hello/world', '/api/hello/[name]'],
            ['/api/hello/other', '/api/hello/other']
          ]
          pathTests.forEach(([url, expectedPath]) => {
            it(`should infer the correct resource path (${expectedPath})`, done => {
              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[1]).to.have.property('resource', `GET ${expectedPath}`)
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://127.0.0.1:${port}${url}`)
                .catch(done)
            })
          })

          it('should propagate context', done => {
            axios
              .get(`http://127.0.0.1:${port}/api/hello/world`)
              .then(res => {
                expect(res.data.name).to.equal('next.request')
                done()
              })
              .catch(done)
          })

          it('should handle routes not found', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[1]).to.have.property('name', 'next.request')
                expect(spans[1]).to.have.property('service', 'test')
                expect(spans[1]).to.have.property('type', 'web')
                expect(spans[1].meta).to.have.property('span.kind', 'server')
                expect(spans[1].meta).to.have.property('http.method', 'GET')
                expect(spans[1].meta).to.have.property('http.status_code', '404')
                expect(spans[1].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/missing`)
              .catch(() => {})
          })

          it('should handle invalid catch all parameters', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[1]).to.have.property('name', 'next.request')
                expect(spans[1]).to.have.property('service', 'test')
                expect(spans[1]).to.have.property('type', 'web')
                expect(spans[1]).to.have.property('resource', 'GET /_error')
                expect(spans[1].meta).to.have.property('span.kind', 'server')
                expect(spans[1].meta).to.have.property('http.method', 'GET')
                expect(spans[1].meta).to.have.property('http.status_code', '400')
                expect(spans[1].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/invalid/%ff`)
              .catch(() => {})
          })

          it('should pass resource path to parent span', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'web.request')
                expect(spans[0]).to.have.property('resource', 'GET /api/hello/[name]')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/hello/world`)
              .catch(done)
          })
        })

        describe('for pages', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[1]).to.have.property('name', 'next.request')
                expect(spans[1]).to.have.property('service', 'test')
                expect(spans[1]).to.have.property('type', 'web')
                expect(spans[1]).to.have.property('resource', 'GET /hello/[name]')
                expect(spans[1].meta).to.have.property('span.kind', 'server')
                expect(spans[1].meta).to.have.property('http.method', 'GET')
                expect(spans[1].meta).to.have.property('http.status_code', '200')
                expect(spans[1].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/hello/world`)
              .catch(done)
          })

          const pathTests = [
            ['/hello', '/hello'],
            ['/hello/world', '/hello/[name]'],
            ['/hello/other', '/hello/other'],
            ['/error/not_found', '/error/not_found', satisfies(pkg.version, '>=10') ? 404 : 500],
            ['/error/get_server_side_props', '/error/get_server_side_props', 500]
          ]
          pathTests.forEach(([url, expectedPath, statusCode]) => {
            it(`should infer the correct resource (${expectedPath})`, done => {
              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[1]).to.have.property('resource', `GET ${expectedPath}`)
                  expect(spans[1].meta).to.have.property('http.status_code', `${statusCode || 200}`)
                })
                .then(done)
                .catch(done)

              axios.get(`http://127.0.0.1:${port}${url}`)
            })
          })

          it('should handle pages not found', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[1]).to.have.property('name', 'next.request')
                expect(spans[1]).to.have.property('service', 'test')
                expect(spans[1]).to.have.property('type', 'web')
                expect(spans[1].meta).to.have.property('span.kind', 'server')
                expect(spans[1].meta).to.have.property('http.method', 'GET')
                expect(spans[1].meta).to.have.property('http.status_code', '404')
                expect(spans[1].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/missing`)
              .catch(() => {})
          })

          it('should pass resource path to parent span', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'web.request')
                expect(spans[0]).to.have.property('resource', 'GET /hello/[name]')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/hello/world`)
              .catch(done)
          })
        })

        describe('for static files', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[1]).to.have.property('name', 'next.request')
                expect(spans[1]).to.have.property('service', 'test')
                expect(spans[1]).to.have.property('type', 'web')
                expect(spans[1]).to.have.property('resource', 'GET /test.txt')
                expect(spans[1].meta).to.have.property('span.kind', 'server')
                expect(spans[1].meta).to.have.property('http.method', 'GET')
                expect(spans[1].meta).to.have.property('http.status_code', '200')
                expect(spans[1].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/test.txt`)
              .catch(done)
          })

          it('should pass resource path to parent span', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'web.request')
                expect(spans[0]).to.have.property('resource', 'GET /test.txt')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/test.txt`)
              .catch(done)
          })
        })

        describe('when an error happens', () => {
          it('should not die', done => {
            agent
              .use(_traces => { })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/error/boom`)
              .catch((response) => {
                expect(response.statusCode).to.eql(500)
              })
          })
        })
      })

      if (satisfies(pkg.version, '>=13.4.0')) {
        describe('with app directory', () => {
          startServer({ withConfig: false, standalone: false })

          it('should infer the correct resource path for appDir routes', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[1]).to.have.property('resource', `GET /api/appDir/[name]`)
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/appDir/hello`)
              .catch(done)
          })

          it('should infer the correct resource path for appDir pages', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[1]).to.have.property('resource', `GET /appDir/[name]`)
                expect(spans[1].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            axios.get(`http://127.0.0.1:${port}/appDir/hello`)
          })
        })
      }

      describe('with configuration', () => {
        startServer({ withConfig: true, standalone: false })

        it('should execute the hook and validate the status only once', done => {
          agent
            .use(traces => {
              const spans = traces[0]

              expect(spans[1]).to.have.property('name', 'next.request')
              expect(spans[1]).to.have.property('service', 'test')
              expect(spans[1]).to.have.property('type', 'web')
              expect(spans[1]).to.have.property('resource', 'GET /api/hello/[name]')
              expect(spans[1]).to.have.property('error', 1)
              expect(spans[1].meta).to.have.property('span.kind', 'server')
              expect(spans[1].meta).to.have.property('http.method', 'GET')
              expect(spans[1].meta).to.have.property('http.status_code', '200')
              expect(spans[1].meta).to.have.property('foo', 'bar')
              expect(spans[1].meta).to.have.property('req', 'IncomingMessage')
              expect(spans[1].meta).to.have.property('component', 'next')

              // assert request hook was only called once across the whole request
              expect(spans[1].meta).to.have.property('times_hook_called', '1')
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://127.0.0.1:${port}/api/hello/world`)
            .catch(done)
        })
      })

      // Issue with 13.4.13 - 13.4.18 causes process.env not to work properly in standalone mode
      // which affects how the tracer is passed down through NODE_OPTIONS, making tests fail
      // https://github.com/vercel/next.js/issues/53367
      // TODO investigate this further - traces appear in the UI for a small test app
      if (satisfiesStandalone(pkg.version) && !satisfies(pkg.version, '13.4.13 - 13.4.18')) {
        describe('with standalone', () => {
          startServer({ withConfig: false, standalone: true })

          // testing basic instrumentation between api, pages, static files since standalone still uses `next-server`
          const standaloneTests = [
            ['api', '/api/hello/world', 'GET /api/hello/[name]'],
            ['pages', '/hello/world', 'GET /hello/[name]'],
            ['static files', '/test.txt', 'GET /test.txt']
          ]

          standaloneTests.forEach(([test, resource, expectedResource]) => {
            it(`should do automatic instrumentation for ${test}`, done => {
              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[1]).to.have.property('name', 'next.request')
                  expect(spans[1]).to.have.property('service', 'test')
                  expect(spans[1]).to.have.property('type', 'web')
                  expect(spans[1]).to.have.property('resource', expectedResource)
                  expect(spans[1].meta).to.have.property('span.kind', 'server')
                  expect(spans[1].meta).to.have.property('http.method', 'GET')
                  expect(spans[1].meta).to.have.property('http.status_code', '200')
                  expect(spans[1].meta).to.have.property('component', 'next')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://127.0.0.1:${port}${resource}`)
                .catch(done)
            }).timeout(5000)
            // increase timeout for longer test in CI
            // locally, do not see any slowdowns
          })
        })
      }
    })
  })
})
