'use strict'

const telemetryMetrics = require('../../../src/telemetry/metrics')
const appsecNamespace = telemetryMetrics.manager.namespace('appsec')

const appsecTelemetry = require('../../../src/appsec/telemetry')
const Config = require('../../../src/config')

describe('Appsec User Telemetry metrics', () => {
  let count, inc

  beforeEach(() => {
    inc = sinon.spy()
    count = sinon.stub(appsecNamespace, 'count').returns({
      inc
    })

    appsecNamespace.metrics.clear()
    appsecNamespace.distributions.clear()
  })

  afterEach(sinon.restore)

  describe('if enabled', () => {
    beforeEach(() => {
      const config = new Config()
      config.telemetry.enabled = true
      config.telemetry.metrics = true

      appsecTelemetry.enable(config)
    })

    describe('incrementMissingUserLoginMetric', () => {
      it('should increment instrum.user_auth.missing_user_login metric', () => {
        appsecTelemetry.incrementMissingUserLoginMetric('passport-local', 'login_success')

        expect(count).to.have.been.calledOnceWithExactly('instrum.user_auth.missing_user_login', {
          framework: 'passport-local',
          event_type: 'login_success'
        })
      })
    })

    describe('incrementMissingUserIdMetric', () => {
      it('should increment instrum.user_auth.missing_user_id metric', () => {
        appsecTelemetry.incrementMissingUserIdMetric('passport', 'authenticated_request')

        expect(count).to.have.been.calledOnceWithExactly('instrum.user_auth.missing_user_id', {
          framework: 'passport',
          event_type: 'authenticated_request'
        })
      })
    })

    describe('incrementSdkEventMetric', () => {
      it('should increment sdk.event metric', () => {
        appsecTelemetry.incrementSdkEventMetric('login_success')

        expect(count).to.have.been.calledOnceWithExactly('sdk.event', {
          event_type: 'login_success',
          sdk_version: 'v1'
        })
      })
    })
  })
})
