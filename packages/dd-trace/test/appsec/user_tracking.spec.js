'use strict'

const assert = require('assert')
const proxyquire = require('proxyquire')

const telemetry = require('../../src/appsec/telemetry')
const { ASM } = require('../../src/standalone/product')

describe('User Tracking', () => {
  let currentTags
  let rootSpan
  let log
  let waf
  let keepTrace

  let setCollectionMode
  let trackLogin
  let trackUser

  beforeEach(() => {
    sinon.stub(telemetry, 'incrementMissingUserLoginMetric')
    sinon.stub(telemetry, 'incrementMissingUserIdMetric')

    waf = { run: sinon.stub().returns(['action1']) }

    currentTags = {}

    rootSpan = {
      context: () => ({ _tags: currentTags }),
      addTags: sinon.stub(),
      setTag: sinon.stub()
    }

    log = {
      warn: sinon.stub(),
      error: sinon.stub()
    }

    keepTrace = sinon.stub()

    const UserTracking = proxyquire('../../src/appsec/user_tracking', {
      '../log': log,
      '../priority_sampler': { keepTrace },
      './waf': waf
    })

    setCollectionMode = UserTracking.setCollectionMode
    trackLogin = UserTracking.trackLogin
    trackUser = UserTracking.trackUser
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('getUserId', () => {
    beforeEach(() => {
      setCollectionMode('identification')
    })

    it('should find an id field in user object', () => {
      const user = {
        notId: 'no',
        id: '123',
        email: 'a@b.c'
      }

      const results = trackLogin('passport-local', 'login', user, true, rootSpan)

      assert.deepStrictEqual(results, ['action1'])

      sinon.assert.notCalled(log.error)
      sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

      sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.users.login.success.track': 'true',
        '_dd.appsec.events.users.login.success.auto.mode': 'identification',
        '_dd.appsec.usr.login': 'login',
        'appsec.events.users.login.success.usr.login': 'login',
        '_dd.appsec.usr.id': '123',
        'usr.id': '123'
      })
      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          'usr.login': 'login',
          'usr.id': '123',
          'server.business_logic.users.login.success': null
        }
      })
    })

    it('should find an id-like field in user object when no id field is present', () => {
      const user = {
        notId: 'no',
        email: 'a@b.c',
        username: 'azerty'
      }

      const results = trackLogin('passport-local', 'login', user, true, rootSpan)

      assert.deepStrictEqual(results, ['action1'])

      sinon.assert.notCalled(log.error)
      sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

      sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.users.login.success.track': 'true',
        '_dd.appsec.events.users.login.success.auto.mode': 'identification',
        '_dd.appsec.usr.login': 'login',
        'appsec.events.users.login.success.usr.login': 'login',
        '_dd.appsec.usr.id': 'a@b.c',
        'usr.id': 'a@b.c'
      })
      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          'usr.login': 'login',
          'usr.id': 'a@b.c',
          'server.business_logic.users.login.success': null
        }
      })
    })

    it('should find a stringifiable id in user object', () => {
      const stringifiableObject = {
        a: 1,
        toString: () => '123'
      }

      const user = {
        notId: 'no',
        id: { a: 1 },
        _id: stringifiableObject,
        email: 'a@b.c'
      }

      const results = trackLogin('passport-local', 'login', user, true, rootSpan)

      assert.deepStrictEqual(results, ['action1'])

      sinon.assert.notCalled(log.error)
      sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

      sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
      sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
        'appsec.events.users.login.success.track': 'true',
        '_dd.appsec.events.users.login.success.auto.mode': 'identification',
        '_dd.appsec.usr.login': 'login',
        'appsec.events.users.login.success.usr.login': 'login',
        '_dd.appsec.usr.id': '123',
        'usr.id': '123'
      })
      sinon.assert.calledOnceWithExactly(waf.run, {
        persistent: {
          'usr.login': 'login',
          'usr.id': '123',
          'server.business_logic.users.login.success': null
        }
      })
    })
  })

  describe('trackLogin', () => {
    it('should not do anything if collectionMode is empty or disabled', () => {
      setCollectionMode('disabled')

      const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, true, rootSpan)

      assert.deepStrictEqual(results, undefined)

      sinon.assert.notCalled(log.error)
      sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)
      sinon.assert.notCalled(keepTrace)
      sinon.assert.notCalled(rootSpan.addTags)
      sinon.assert.notCalled(waf.run)
    })

    it('should log error and send telemetry when login success is not a string', () => {
      setCollectionMode('identification')

      const results = trackLogin('passport-local', {}, { id: '123', email: 'a@b.c' }, true, rootSpan)

      assert.deepStrictEqual(results, undefined)

      sinon.assert.calledOnceWithExactly(log.error, '[ASM] Invalid login provided to AppSec trackLogin')
      sinon.assert.calledOnceWithExactly(telemetry.incrementMissingUserLoginMetric, 'passport-local', 'login_success')
      sinon.assert.notCalled(keepTrace)
      sinon.assert.notCalled(rootSpan.addTags)
      sinon.assert.notCalled(waf.run)
    })

    it('should log error and send telemetry when login failure is not a string', () => {
      setCollectionMode('identification')

      const results = trackLogin('passport-local', {}, { id: '123', email: 'a@b.c' }, false, rootSpan)

      assert.deepStrictEqual(results, undefined)

      sinon.assert.calledOnceWithExactly(log.error, '[ASM] Invalid login provided to AppSec trackLogin')
      sinon.assert.calledOnceWithExactly(telemetry.incrementMissingUserLoginMetric, 'passport-local', 'login_failure')
      sinon.assert.notCalled(keepTrace)
      sinon.assert.notCalled(rootSpan.addTags)
      sinon.assert.notCalled(waf.run)
    })

    describe('when collectionMode is indentification', () => {
      beforeEach(() => {
        setCollectionMode('identification')
      })

      it('should write tags and call waf when success is true', () => {
        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, true, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.auto.mode': 'identification',
          '_dd.appsec.usr.login': 'login',
          'appsec.events.users.login.success.usr.login': 'login',
          '_dd.appsec.usr.id': '123',
          'usr.id': '123'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'login',
            'usr.id': '123',
            'server.business_logic.users.login.success': null
          }
        })
      })

      it('should write tags and call waf when success is false', () => {
        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, false, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.auto.mode': 'identification',
          '_dd.appsec.usr.login': 'login',
          'appsec.events.users.login.failure.usr.login': 'login',
          '_dd.appsec.usr.id': '123',
          'appsec.events.users.login.failure.usr.id': '123'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'login',
            'server.business_logic.users.login.failure': null
          }
        })
      })

      it('should not overwrite tags set by SDK when success is true', () => {
        currentTags = {
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'sdk_login',
          'usr.id': 'sdk_id'
        }

        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, true, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.auto.mode': 'identification',
          '_dd.appsec.usr.login': 'login',
          '_dd.appsec.usr.id': '123'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'login',
            'server.business_logic.users.login.success': null
          }
        })
      })

      it('should not overwwrite tags set by SDK when success is false', () => {
        currentTags = {
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'sdk_login',
          'appsec.events.users.login.failure.usr.id': 'sdk_id'
        }

        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, false, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.auto.mode': 'identification',
          '_dd.appsec.usr.login': 'login',
          '_dd.appsec.usr.id': '123'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'login',
            'server.business_logic.users.login.failure': null
          }
        })
      })

      it('should write tags and call waf without user object when success is true', () => {
        const results = trackLogin('passport-local', 'login', null, true, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.auto.mode': 'identification',
          '_dd.appsec.usr.login': 'login',
          'appsec.events.users.login.success.usr.login': 'login'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'login',
            'server.business_logic.users.login.success': null
          }
        })
      })

      it('should write tags and call waf without user object when success is false', () => {
        const results = trackLogin('passport-local', 'login', null, false, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.auto.mode': 'identification',
          '_dd.appsec.usr.login': 'login',
          'appsec.events.users.login.failure.usr.login': 'login'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'login',
            'server.business_logic.users.login.failure': null
          }
        })
      })
    })

    describe('when collectionMode is anonymization', () => {
      beforeEach(() => {
        setCollectionMode('anonymization')
      })

      it('should write tags and call waf when success is true', () => {
        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, true, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.auto.mode': 'anonymization',
          '_dd.appsec.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          'appsec.events.users.login.success.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          '_dd.appsec.usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8',
          'usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'anon_428821350e9691491f616b754cd8315f',
            'usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8',
            'server.business_logic.users.login.success': null
          }
        })
      })

      it('should write tags and call waf when success is false', () => {
        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, false, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.auto.mode': 'anonymization',
          '_dd.appsec.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          'appsec.events.users.login.failure.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          '_dd.appsec.usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8',
          'appsec.events.users.login.failure.usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'anon_428821350e9691491f616b754cd8315f',
            'server.business_logic.users.login.failure': null
          }
        })
      })

      it('should not overwrite tags set by SDK when success is true', () => {
        currentTags = {
          '_dd.appsec.events.users.login.success.sdk': 'true',
          'appsec.events.users.login.success.usr.login': 'sdk_login',
          'usr.id': 'sdk_id'
        }

        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, true, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.auto.mode': 'anonymization',
          '_dd.appsec.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          '_dd.appsec.usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'anon_428821350e9691491f616b754cd8315f',
            'server.business_logic.users.login.success': null
          }
        })
      })

      it('should not overwwrite tags set by SDK when success is false', () => {
        currentTags = {
          '_dd.appsec.events.users.login.failure.sdk': 'true',
          'appsec.events.users.login.failure.usr.login': 'sdk_login',
          'appsec.events.users.login.failure.usr.id': 'sdk_id'
        }

        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, false, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.auto.mode': 'anonymization',
          '_dd.appsec.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          '_dd.appsec.usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'anon_428821350e9691491f616b754cd8315f',
            'server.business_logic.users.login.failure': null
          }
        })
      })

      it('should write tags and call waf without user object when success is true', () => {
        const results = trackLogin('passport-local', 'login', null, true, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.auto.mode': 'anonymization',
          '_dd.appsec.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          'appsec.events.users.login.success.usr.login': 'anon_428821350e9691491f616b754cd8315f'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'anon_428821350e9691491f616b754cd8315f',
            'server.business_logic.users.login.success': null
          }
        })
      })

      it('should write tags and call waf without user object when success is false', () => {
        const results = trackLogin('passport-local', 'login', null, false, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.failure.track': 'true',
          '_dd.appsec.events.users.login.failure.auto.mode': 'anonymization',
          '_dd.appsec.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          'appsec.events.users.login.failure.usr.login': 'anon_428821350e9691491f616b754cd8315f'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'anon_428821350e9691491f616b754cd8315f',
            'server.business_logic.users.login.failure': null
          }
        })
      })
    })

    describe('collectionMode aliases', () => {
      it('should log warning and use anonymization mode when collectionMode is safe', () => {
        setCollectionMode('safe')

        sinon.assert.calledOnceWithExactly(
          log.warn,
          '[ASM] Using deprecated value "safe" in config.appsec.eventTracking.mode'
        )

        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, true, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.auto.mode': 'anonymization',
          '_dd.appsec.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          'appsec.events.users.login.success.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          '_dd.appsec.usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8',
          'usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'anon_428821350e9691491f616b754cd8315f',
            'usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8',
            'server.business_logic.users.login.success': null
          }
        })
      })

      it('should use anonymization mode when collectionMode is anon', () => {
        setCollectionMode('anon')

        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, true, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.auto.mode': 'anonymization',
          '_dd.appsec.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          'appsec.events.users.login.success.usr.login': 'anon_428821350e9691491f616b754cd8315f',
          '_dd.appsec.usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8',
          'usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'anon_428821350e9691491f616b754cd8315f',
            'usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8',
            'server.business_logic.users.login.success': null
          }
        })
      })

      it('should log warning and use identification mode when collectionMode is extended', () => {
        setCollectionMode('extended')

        sinon.assert.calledOnceWithExactly(
          log.warn,
          '[ASM] Using deprecated value "extended" in config.appsec.eventTracking.mode'
        )

        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, true, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.auto.mode': 'identification',
          '_dd.appsec.usr.login': 'login',
          'appsec.events.users.login.success.usr.login': 'login',
          '_dd.appsec.usr.id': '123',
          'usr.id': '123'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'login',
            'usr.id': '123',
            'server.business_logic.users.login.success': null
          }
        })
      })

      it('should use identification mode when collectionMode is ident', () => {
        setCollectionMode('ident')

        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, true, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)

        sinon.assert.calledOnceWithExactly(keepTrace, rootSpan, ASM)
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'appsec.events.users.login.success.track': 'true',
          '_dd.appsec.events.users.login.success.auto.mode': 'identification',
          '_dd.appsec.usr.login': 'login',
          'appsec.events.users.login.success.usr.login': 'login',
          '_dd.appsec.usr.id': '123',
          'usr.id': '123'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.login': 'login',
            'usr.id': '123',
            'server.business_logic.users.login.success': null
          }
        })
      })

      it('should use disabled mode when collectionMode is not recognized', () => {
        setCollectionMode('saperlipopette')

        const results = trackLogin('passport-local', 'login', { id: '123', email: 'a@b.c' }, true, rootSpan)

        assert.deepStrictEqual(results, undefined)

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserLoginMetric)
        sinon.assert.notCalled(keepTrace)
        sinon.assert.notCalled(rootSpan.addTags)
        sinon.assert.notCalled(waf.run)
      })
    })
  })

  describe('trackUser', () => {
    it('should not do anything if collectionMode is empty or disabled', () => {
      setCollectionMode('disabled')

      const results = trackUser({ id: '123', email: 'a@b.c' }, rootSpan)

      assert.deepStrictEqual(results, undefined)

      sinon.assert.notCalled(log.error)
      sinon.assert.notCalled(telemetry.incrementMissingUserIdMetric)
      sinon.assert.notCalled(rootSpan.setTag)
      sinon.assert.notCalled(rootSpan.addTags)
      sinon.assert.notCalled(waf.run)
    })

    it('should log error and send telemetry when user ID is not found', () => {
      setCollectionMode('identification')

      const results = trackUser({ notAnId: 'bonjour' }, rootSpan)

      assert.deepStrictEqual(results, undefined)

      sinon.assert.calledOnceWithExactly(log.error, '[ASM] No valid user ID found in AppSec trackUser')
      sinon.assert.calledOnceWithExactly(telemetry.incrementMissingUserIdMetric, 'passport', 'authenticated_request')
      sinon.assert.notCalled(rootSpan.setTag)
      sinon.assert.notCalled(rootSpan.addTags)
      sinon.assert.notCalled(waf.run)
    })

    describe('when collectionMode is indentification', () => {
      beforeEach(() => {
        setCollectionMode('identification')
      })

      it('should write tags and call waf', () => {
        const results = trackUser({ id: '123', email: 'a@b.c' }, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserIdMetric)

        sinon.assert.calledOnceWithExactly(rootSpan.setTag, '_dd.appsec.usr.id', '123')
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'usr.id': '123',
          '_dd.appsec.user.collection_mode': 'identification'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.id': '123'
          }
        })
      })

      it('should not overwrite tags set by SDK', () => {
        currentTags = {
          'usr.id': 'sdk_id',
          '_dd.appsec.user.collection_mode': 'sdk'
        }

        const results = trackUser({ id: '123', email: 'a@b.c' }, rootSpan)

        assert.deepStrictEqual(results, undefined)

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserIdMetric)

        sinon.assert.calledOnceWithExactly(rootSpan.setTag, '_dd.appsec.usr.id', '123')

        sinon.assert.notCalled(rootSpan.addTags)
        sinon.assert.notCalled(waf.run)
      })
    })

    describe('when collectionMode is anonymization', () => {
      beforeEach(() => {
        setCollectionMode('anonymization')
      })

      it('should write tags and call waf', () => {
        const results = trackUser({ id: '123', email: 'a@b.c' }, rootSpan)

        assert.deepStrictEqual(results, ['action1'])

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserIdMetric)

        sinon.assert.calledOnceWithExactly(
          rootSpan.setTag,
          '_dd.appsec.usr.id',
          'anon_a665a45920422f9d417e4867efdc4fb8'
        )
        sinon.assert.calledOnceWithExactly(rootSpan.addTags, {
          'usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8',
          '_dd.appsec.user.collection_mode': 'anonymization'
        })
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.id': 'anon_a665a45920422f9d417e4867efdc4fb8'
          }
        })
      })

      it('should not overwrite tags set by SDK', () => {
        currentTags = {
          'usr.id': 'sdk_id',
          '_dd.appsec.user.collection_mode': 'sdk'
        }

        const results = trackUser({ id: '123', email: 'a@b.c' }, rootSpan)

        assert.deepStrictEqual(results, undefined)

        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(telemetry.incrementMissingUserIdMetric)

        sinon.assert.calledOnceWithExactly(
          rootSpan.setTag,
          '_dd.appsec.usr.id',
          'anon_a665a45920422f9d417e4867efdc4fb8'
        )

        sinon.assert.notCalled(rootSpan.addTags)
        sinon.assert.notCalled(waf.run)
      })
    })
  })
})
