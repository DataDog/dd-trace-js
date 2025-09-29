'use strict'

const { expect } = require('chai')
const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')

const telemetryLog = dc.channel('datadog:telemetry:log')

describe('Telemetry logs', () => {
  let telemetry
  let clock
  let start, send

  before(() => {
    clock = sinon.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
  })

  after(() => {
    clock.restore()
    telemetry.stop()
  })

  it('should be started and send logs when log received via the datadog:telemetry:log channel', () => {
    start = sinon.stub()
    send = sinon.spy()

    telemetry = proxyquire('../../../../src/telemetry/telemetry', {
      '../exporters/common/docker': {
        id () {
          return 'test docker id'
        }
      },
      './logs': {
        start,
        send
      }
    })

    const config = {
      telemetry: { enabled: true, heartbeatInterval: 3000, logCollection: true },
      version: '1.2.3-beta4',
      appsec: { enabled: false },
      profiling: { enabled: false },
      env: 'preprod',
      tags: {
        'runtime-id': '1a2b3c'
      }
    }

    telemetry.start(config, {
      _pluginsByName: {}
    })

    telemetryLog.publish({ message: 'This is an Error', level: 'ERROR' })

    clock.tick(3000)

    expect(start).to.be.calledOnceWith(config)
    expect(send).to.be.calledOnceWith(config)
  })
})
