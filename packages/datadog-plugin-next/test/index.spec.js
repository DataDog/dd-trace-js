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
    // TODO: Figure out why 10.x tests are failing.
    withVersions('next', 'next', DD_MAJOR >= 4 && '>=11', version => {
      const startServer = (withConfig = false, schemaVersion = 'v0', defaultToGlobalService = false) => {
        before(async () => {
          port = await getPort()

          return agent.load('next')
        })

        before(function (done) {
          const cwd = __dirname

          server = spawn('node', ['server'], {
            cwd,
            env: {
              ...process.env,
              VERSION: version,
              PORT: port,
              DD_TRACE_AGENT_PORT: agent.server.address().port,
              WITH_CONFIG: withConfig,
              DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: schemaVersion,
              DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: defaultToGlobalService
            }
          })

          server.once('error', done)
          server.stdout.once('data', () => done())
          server.stderr.on('data', chunk => process.stderr.write(chunk))
          server.stdout.on('data', chunk => process.stdout.write(chunk))
        })

        after(async function () {
          this.timeout(5000)
          server.kill()
          await axios.get(`http://localhost:${port}/api/hello/world`).catch(() => {})
          await agent.close({ ritmReset: false })
        })
      }

      before(async function () {
        this.timeout(120 * 1000) // Webpack is very slow and builds on every test run

        const cwd = __dirname
        const nodules = `${__dirname}/../../../versions/next@${version}/node_modules`
        const pkg = require(`${__dirname}/../../../versions/next@${version}/package.json`)
        const realVersion = require(`${__dirname}/../../../versions/next@${version}`).version()

        if (realVersion.startsWith('10')) {
          return this.skip() // TODO: Figure out why 10.x tests fail.
        }

        delete pkg.workspaces

        execSync(`cp -R '${nodules}' ./`, { cwd })

        writeFileSync(`${__dirname}/package.json`, JSON.stringify(pkg, null, 2))

        // building in-process makes tests fail for an unknown reason
        execSync('yarn exec next build', {
          cwd,
          env: {
            ...process.env,
            version
          },
          stdio: ['pipe', 'ignore', 'pipe']
        })
      })

      after(function () {
        this.timeout(5000)
        const files = [
          'package.json',
          'node_modules',
          '.next'
        ]
        const paths = files.map(file => `${__dirname}/${file}`)
        execSync(`rm -rf ${paths.join(' ')}`)
      })

      withNamingSchema(
        (done) => {
          axios
            .get(`http://localhost:${port}/api/hello/world`)
            .catch(done)
        },
        rawExpectedSchema.server,
        {
          hooks: (version, defaultToGlobalService) => startServer(false, version, defaultToGlobalService)
        }
      )

      describe('without configuration', () => {
        startServer()

        describe('for api routes', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /api/hello/[name]')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
                expect(spans[0].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/api/hello/world`)
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

                  expect(spans[0]).to.have.property('resource', `GET ${expectedPath}`)
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}${url}`)
                .catch(done)
            })
          })

          it('should propagate context', done => {
            axios
              .get(`http://localhost:${port}/api/hello/world`)
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

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '404')
                expect(spans[0].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/api/missing`)
              .catch(() => {})
          })

          it('should handle invalid catch all parameters', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /_error')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '400')
                expect(spans[0].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/api/invalid/%ff`)
              .catch(() => {})
          })
        })

        describe('for pages', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /hello/[name]')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
                expect(spans[0].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/hello/world`)
              .catch(done)
          })

          const pkg = require(`${__dirname}/../../../versions/next@${version}/node_modules/next/package.json`)

          const pathTests = [
            ['/hello', '/hello'],
            ['/hello/world', '/hello/[name]'],
            ['/hello/other', '/hello/other'],
            ['/error/not_found', '/error/not_found', satisfies(pkg.version, '>=11') ? 404 : 500],
            ['/error/get_server_side_props', '/error/get_server_side_props', 500]
          ]
          pathTests.forEach(([url, expectedPath, statusCode]) => {
            it(`should infer the corrrect resource (${expectedPath})`, done => {
              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[0]).to.have.property('resource', `GET ${expectedPath}`)
                  expect(spans[0].meta).to.have.property('http.status_code', `${statusCode || 200}`)
                })
                .then(done)
                .catch(done)

              axios.get(`http://localhost:${port}${url}`)
            })
          })

          it('should handle pages not found', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '404')
                expect(spans[0].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/missing`)
              .catch(() => {})
          })
        })

        describe('for static files', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'next.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
                expect(spans[0].meta).to.have.property('component', 'next')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/test.txt`)
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
              .get(`http://localhost:${port}/api/error/boom`)
              .catch((response) => {
                expect(response.statusCode).to.eql(500)
              })
          })
        })
      })

      describe('with configuration', () => {
        startServer(true)

        it('should execute the hook and validate the status', done => {
          agent
            .use(traces => {
              const spans = traces[0]

              expect(spans[0]).to.have.property('name', 'next.request')
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('type', 'web')
              expect(spans[0]).to.have.property('resource', 'GET /api/hello/[name]')
              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0].meta).to.have.property('span.kind', 'server')
              expect(spans[0].meta).to.have.property('http.method', 'GET')
              expect(spans[0].meta).to.have.property('http.status_code', '200')
              expect(spans[0].meta).to.have.property('foo', 'bar')
              expect(spans[0].meta).to.have.property('component', 'next')
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://localhost:${port}/api/hello/world`)
            .catch(done)
        })
      })
    })
  })
})
