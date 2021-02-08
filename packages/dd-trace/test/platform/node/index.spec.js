'use strict'

const nock = require('nock')
const os = require('os')
const semver = require('semver')
const { execSync } = require('child_process')

wrapIt()

describe('Platform', () => {
  describe('Node', () => {
    let platform

    if (os.platform() !== 'win32') {
      describe('in pre-require', () => {
        it('should load the package.json correctly', () => {
          const pkg = JSON.parse(execSync(`node --require ./pkg-loader.js -e ""`, {
            cwd: __dirname
          }).toString())
          expect(pkg.name).to.equal('dd-trace')
        })
      })
    }

    describe('name', () => {
      beforeEach(() => {
        platform = require('../../../src/platform/node')
      })

      it('should return nodejs', () => {
        expect(platform.name()).to.equal('nodejs')
      })
    })

    describe('version', () => {
      beforeEach(() => {
        platform = require('../../../src/platform/node')
      })

      it('should return the process version', () => {
        const version = platform.version()

        expect(version).to.be.a('string')
        expect(semver.eq(version, semver.valid(version))).to.be.true
      })
    })

    describe('engine', () => {
      let realEngine

      beforeEach(() => {
        platform = require('../../../src/platform/node')
        realEngine = process.jsEngine
      })

      afterEach(() => {
        process.jsEngine = realEngine
      })

      it('should return the correct engine for Chakra', () => {
        process.jsEngine = 'chakracore'

        expect(platform.engine()).to.equal('chakracore')
      })

      it('should return the correct engine for V8', () => {
        delete process.jsEngine

        expect(platform.engine()).to.equal('v8')
      })
    })

    describe('crypto', () => {
      let crypto
      let randomBytes
      let buffer

      beforeEach(() => {
        buffer = Buffer.alloc(4)

        buffer.writeUInt32BE(0xabcd1234)

        randomBytes = sinon.stub().returns(buffer)

        crypto = proxyquire('../src/platform/node/crypto', {
          'crypto': { randomBytes }
        })
      })

      it('should fill the typed array with random values', () => {
        const typedArray = new Uint8Array(4)

        crypto.getRandomValues(typedArray)

        expect(typedArray[0]).to.equal(0xab)
        expect(typedArray[1]).to.equal(0xcd)
        expect(typedArray[2]).to.equal(0x12)
        expect(typedArray[3]).to.equal(0x34)
      })
    })

    describe('now', () => {
      let now
      let performanceNow

      beforeEach(() => {
        performanceNow = sinon.stub().returns(100.1111)
        now = proxyquire('../src/platform/node/now', {
          'performance-now': performanceNow
        })
      })

      it('should return the ticks since process start in milliseconds with high resolution', () => {
        expect(now()).to.equal(100.1111)
      })
    })

    describe('service', () => {
      beforeEach(() => {
        platform = require('../../../src/platform/node')
      })

      afterEach(() => {
        delete process.env['AWS_LAMBDA_FUNCTION_NAME']
      })

      it('should load the service name from the main module', () => {
        const name = platform.service()

        expect(name).to.equal('mocha')
      })

      it('should use the use the lambda function name as the service when in AWS Lambda', () => {
        process.env['AWS_LAMBDA_FUNCTION_NAME'] = 'my-function-name'
        const result = platform.service()
        expect(result).to.equal('my-function-name')
      })
    })

    describe('appVersion', () => {
      beforeEach(() => {
        platform = require('../../../src/platform/node')
      })

      it('should load the version number from the main module', () => {
        const version = platform.appVersion()

        expect(version).to.match(/^\d+.\d+.\d+/)
      })
    })

    describe('docker', () => {
      let docker
      let fs

      beforeEach(() => {
        fs = {
          readFileSync: sinon.stub()
        }
      })

      it('should return an empty ID when the cgroup cannot be read', () => {
        docker = proxyquire('../src/platform/node/docker', { fs })

        expect(docker.id()).to.be.undefined
      })

      it('should support IDs with long format', () => {
        const cgroup = [
          '1:name=systemd:/docker/34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376'
        ].join('\n')

        fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
        docker = proxyquire('../src/platform/node/docker', { fs })

        expect(docker.id()).to.equal('34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376')
      })

      it('should support IDs with UUID format', () => {
        const cgroup = [
          '1:name=systemd:/uuid/34dc0b5e-626f-2c5c-4c51-70e34b10e765'
        ].join('\n')

        fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
        docker = proxyquire('../src/platform/node/docker', { fs })

        expect(docker.id()).to.equal('34dc0b5e-626f-2c5c-4c51-70e34b10e765')
      })

      it('should support IDs with ECS task format', () => {
        const cgroup = [
          '1:name=systemd:/ecs/34dc0b5e626f2c5c4c5170e34b10e765-1234567890'
        ].join('\n')

        fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
        docker = proxyquire('../src/platform/node/docker', { fs })

        expect(docker.id()).to.equal('34dc0b5e626f2c5c4c5170e34b10e765-1234567890')
      })

      it('should support IDs with scope suffix', () => {
        const cgroup = [
          '1:name=systemd:/docker/34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376.scope'
        ].join('\n')

        fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
        docker = proxyquire('../src/platform/node/docker', { fs })

        expect(docker.id()).to.equal('34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376')
      })

      it('should support finding IDs on any line of the cgroup', () => {
        const cgroup = [
          '1:name=systemd:/nope',
          '2:pids:/docker/34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376',
          '3:cpu:/invalid'
        ].join('\n')

        fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
        docker = proxyquire('../src/platform/node/docker', { fs })

        expect(docker.id()).to.equal('34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376')
      })
    })

    describe('request', () => {
      let request
      let log
      let docker

      beforeEach(() => {
        nock.disableNetConnect()

        log = {
          error: sinon.spy()
        }
        docker = {
          id: sinon.stub().returns('abcd')
        }
        platform = require('../../../src/platform/node')
        request = proxyquire('../src/platform/node/request', {
          './docker': docker,
          '../../log': log
        }).bind(platform)
      })

      afterEach(() => {
        nock.cleanAll()
        nock.enableNetConnect()
      })

      it('should send an http request with a buffer', () => {
        nock('http://test:123', {
          reqheaders: {
            'content-type': 'application/octet-stream',
            'content-length': '13'
          }
        })
          .put('/path', { foo: 'bar' })
          .reply(200, 'OK')

        return request({
          protocol: 'http:',
          hostname: 'test',
          port: 123,
          path: '/path',
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream'
          },
          data: Buffer.from(JSON.stringify({ foo: 'bar' }))
        }, (err, res) => {
          expect(res).to.equal('OK')
        })
      })

      it('should send an http request with a buffer array', () => {
        nock('http://test:123', {
          reqheaders: {
            'content-type': 'application/octet-stream',
            'content-length': '8'
          }
        })
          .put('/path', 'fizzbuzz')
          .reply(200, 'OK')

        return request({
          protocol: 'http:',
          hostname: 'test',
          port: 123,
          path: '/path',
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream'
          },
          data: [Buffer.from('fizz', 'utf-8'), Buffer.from('buzz', 'utf-8')]
        }, (err, res) => {
          expect(res).to.equal('OK')
        })
      })

      it('should handle an http error', done => {
        nock('http://localhost:80')
          .put('/path')
          .reply(400)

        request({
          path: '/path',
          method: 'PUT'
        }, err => {
          expect(err).to.be.instanceof(Error)
          expect(err.message).to.equal('Error from the agent: 400 Bad Request')
          done()
        })
      })

      it('should timeout after 2 seconds by default', done => {
        nock('http://localhost:80')
          .put('/path')
          .socketDelay(2001)
          .reply(200)

        request({
          path: '/path',
          method: 'PUT'
        }, err => {
          expect(err).to.be.instanceof(Error)
          expect(err.message).to.equal('Network error trying to reach the agent: socket hang up')
          done()
        })
      })

      it('should have a configurable timeout', done => {
        nock('http://localhost:80')
          .put('/path')
          .socketDelay(2001)
          .reply(200)

        request({
          path: '/path',
          method: 'PUT',
          timeout: 2000
        }, err => {
          expect(err).to.be.instanceof(Error)
          expect(err.message).to.equal('Network error trying to reach the agent: socket hang up')
          done()
        })
      })

      it('should inject the container ID', () => {
        nock('http://test:123', {
          reqheaders: {
            'datadog-container-id': 'abcd'
          }
        })
          .get('/')
          .reply(200, 'OK')

        return request({
          hostname: 'test',
          port: 123,
          path: '/'
        }, (err, res) => {
          expect(res).to.equal('OK')
        })
      })
    })
  })
})
