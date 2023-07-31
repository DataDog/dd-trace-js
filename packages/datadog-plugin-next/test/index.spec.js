'use strict'

/* eslint import/no-extraneous-dependencies: ["error", {"packageDir": ['./']}] */

const axios = require('axios')
const getPort = require('get-port')
const { execSync, spawn } = require('child_process')
const agent = require('../../dd-trace/test/plugins/agent')
const { writeSync, writeFileSync, readFileSync, openSync, close, existsSync } = require('fs')
const { satisfies } = require('semver')
const { DD_MAJOR } = require('../../../version')
const path = require('path')

describe('Plugin', function () {
  let server
  let port

  describe('next', () => {
    const startServer = ({ withConfig, standalone, startViaNodeOptions }, version) => {
      before(async () => {
        port = await getPort()

        return agent.load('next')
      })

      before(function (done) {
        const cwd = standalone
          ? `${__dirname}/.next/standalone`
          : __dirname

        const serverStartCmd =
          startViaNodeOptions ? ['--require', `${__dirname}/datadog.js`, 'server'] : ['server']

        server = spawn('node', serverStartCmd, {
          cwd,
          env: {
            ...process.env,
            VERSION: version,
            PORT: port,
            DD_TRACE_AGENT_PORT: agent.server.address().port,
            WITH_CONFIG: withConfig
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

    const build = version => {
      before(async function () {
        this.timeout(120 * 1000) // Webpack is very slow and builds on every test run

        const cwd = __dirname
        const pkg = require(`${__dirname}/../../../versions/next@${version}/package.json`)
        const realVersion = require(`${__dirname}/../../../versions/next@${version}`).version()

        if (realVersion.startsWith('10')) {
          return this.skip() // TODO: Figure out why 10.x tests fail.
        }

        delete pkg.workspaces

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
    }

    const initStandaloneFiles = () => {
      before(() => {
        // insert tracer init into auto-generated server.js
        const fileName = `${__dirname}/.next/standalone/server.js`
        const fileData = readFileSync(fileName)
        const file = openSync(fileName, 'w+')
        const lineInjection = `
          const tracer = require('../../../../..').init({
            service: 'test',
            flushInterval: 0,
            plugins: false
          }).use('next', process.env.WITH_CONFIG ? {
            validateStatus: code => false,
            hooks: {
              request: (span) => {
                span.setTag('foo', 'bar')
              }
            }
          } : true);
        `
        const tracerImportStmt = Buffer.from(lineInjection)

        writeSync(file, tracerImportStmt, 0, tracerImportStmt.length, 0)
        writeSync(file, fileData, 0, fileData.length, tracerImportStmt.length)
        close(file, err => { if (err) { throw err } })

        // for problems with Next.js, replace main entrypoint in an ill-copied package.json
        // https://github.com/vercel/next.js/issues/40735#issuecomment-1314151000
        const EMPTY_FILE_TEMPLATE = `"use strict";
        Object.defineProperty(exports, "__esModule", {
            value: true
        });
        exports.default = void 0;
        `
        const nextJSPackageDir = path.resolve(__dirname, '.next/standalone/node_modules/next')
        const nextJSPackageJson = JSON.parse(readFileSync(path.join(nextJSPackageDir, 'package.json'), 'utf-8'))
        const mainEntryFile = path.join(nextJSPackageDir, nextJSPackageJson.main)
        if (!existsSync(mainEntryFile)) writeFileSync(mainEntryFile, EMPTY_FILE_TEMPLATE)

        // copy public directory for static files
        const publicOrigin = `${__dirname}/public`
        const publicDestination = `${__dirname}/.next/standalone/public`
        execSync(`mkdir ${publicDestination}`)
        execSync(`cp ${publicOrigin}/test.txt ${publicDestination}/test.txt`)
      })
    }

    // TODO: Figure out why 10.x tests are failing.
    withVersions('next', 'next', DD_MAJOR >= 4 && '>=11', version => {
      build(version)

      describe('without configuration', () => {
        startServer({ withConfig: false, standalone: false, startViaNodeOptions: false }, version)

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
            it(`should infer the corrrect resource path (${expectedPath})`, done => {
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
        startServer({ withConfig: true, standalone: false, startViaNodeOptions: false }, version)

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

    // Next.js run in standalone
    // Since it uses `next-server`, only testing automatic instrumentation
    withVersions('next', 'next', '>=12.0.0 <13.4.0', version => {
      build(version)
      initStandaloneFiles()

      describe('standalone without configuration', () => {
        startServer({ withConfig: false, standalone: true, startViaNodeOptions: false }, version)

        it('should do automatic instrumentation for pages', done => {
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

        it('should do automatic instrumentation for pages', done => {
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

        it('should do automatic instrumentation for static files', done => {
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

      describe('standalone with configuration', () => {
        startServer({ withConfig: true, standalone: true, startViaNodeOptions: false }, version)

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

    withVersions('next', 'next', '>=13.4.0', version => {
      build(version)
      initStandaloneFiles()

      describe(`standalone version with worker without config`, () => {
        startServer({ withConfig: false, standalone: true, startViaNodeOptions: true }, version)

        it('should do automatic instrumentation for pages', done => {
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

        it('should do automatic instrumentation for pages', done => {
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

        it('should do automatic instrumentation for static files', done => {
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

      describe(`standalone version with worker with config`, () => {
        startServer({ withConfig: false, standalone: true, startViaNodeOptions: true }, version)

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
