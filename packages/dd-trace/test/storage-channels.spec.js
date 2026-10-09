'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('./setup/core')

const datadogCore = require('../../datadog-core')
const datadogCoreStorage = require('../../datadog-core/src/storage')

describe('storage-channels', () => {
  const legacyStorage = datadogCore.storage('legacy')
  const prototype = Object.getPrototypeOf(legacyStorage)

  function nextAsyncCallback () {
    return new Promise(resolve => setImmediate(resolve))
  }

  function assertUninstrumented () {
    assert.strictEqual(Object.hasOwn(legacyStorage, 'enterWith'), false)
    assert.strictEqual(Object.hasOwn(legacyStorage, 'run'), false)
    assert.strictEqual(legacyStorage.enterWith, prototype.enterWith)
    assert.strictEqual(legacyStorage.run, prototype.run)
  }

  // Exercise the non-ACF code path even on an ACF runtime: there the real run()
  // still delegates to enterWith(), which the run() wrapper tolerates by
  // suppressing nested publishes. The reverse can't be simulated: on a non-ACF
  // runtime, run() restores the prior store without going through enterWith(),
  // so the ACF code path would miss the publish on exit from run().
  const runtimeModes = datadogCoreStorage.isACFActive ? [true, false] : [false]
  for (const isACFActive of runtimeModes) {
    describe(`with isACFActive=${isACFActive}`, () => {
      let enterCh
      let beforeCh
      let acquireChannels
      let releaseChannels
      let onEnter
      let onBefore
      let held

      function acquire (needsBeforeHook) {
        acquireChannels(needsBeforeHook)
        held.push(needsBeforeHook)
      }

      function release (needsBeforeHook) {
        releaseChannels(needsBeforeHook)
        held.splice(held.indexOf(needsBeforeHook), 1)
      }

      beforeEach(() => {
        ({ enterCh, beforeCh, acquireChannels, releaseChannels } = proxyquire('../src/storage-channels', {
          '../../datadog-core/src/storage': { ...datadogCoreStorage, isACFActive },
        }))
        onEnter = sinon.spy()
        onBefore = sinon.spy()
        enterCh.subscribe(onEnter)
        beforeCh.subscribe(onBefore)
        held = []
      })

      afterEach(() => {
        enterCh.unsubscribe(onEnter)
        beforeCh.unsubscribe(onBefore)
        // Balance any acquisition a failed test left behind.
        for (const needsBeforeHook of held) releaseChannels(needsBeforeHook)
      })

      it('should not instrument legacy storage before acquisition', () => {
        assertUninstrumented()
        legacyStorage.run({}, () => {})
        sinon.assert.notCalled(onEnter)
      })

      it(`should ${isACFActive ? 'not ' : ''}instrument run()`, () => {
        acquire(false)
        assert.strictEqual(Object.hasOwn(legacyStorage, 'run'), !isACFActive)
      })

      it('should publish on run() and its callback while acquired', () => {
        acquire(false)
        legacyStorage.run({}, () => {
          sinon.assert.calledOnce(onEnter)
        })
        // With ACF, the exit from run() goes through enterWith() too.
        sinon.assert.calledTwice(onEnter)
      })

      for (const needsBeforeHook of [true, false]) {
        describe(`with needsBeforeHook=${needsBeforeHook}`, () => {
          it('should publish on enterWith() while acquired', () => {
            acquire(needsBeforeHook)
            legacyStorage.enterWith({})
            sinon.assert.calledOnce(onEnter)
          })

          it(`should ${needsBeforeHook ? '' : 'not '}publish async hook "before" events while acquired`, async () => {
            acquire(needsBeforeHook)
            await nextAsyncCallback()
            assert.strictEqual(onBefore.called, needsBeforeHook)
          })

          it('should restore legacy storage methods and disable the async hook when released', async () => {
            acquire(needsBeforeHook)
            release(needsBeforeHook)

            assertUninstrumented()
            legacyStorage.enterWith({})
            legacyStorage.run({}, () => {})
            await nextAsyncCallback()
            sinon.assert.notCalled(onEnter)
            sinon.assert.notCalled(onBefore)
          })

          it('should instrument again when acquired again', async () => {
            acquire(needsBeforeHook)
            release(needsBeforeHook)
            acquire(needsBeforeHook)

            legacyStorage.enterWith({})
            sinon.assert.calledOnce(onEnter)
            await nextAsyncCallback()
            assert.strictEqual(onBefore.called, needsBeforeHook)
          })

          it('should stay acquired until the last consumer releases', () => {
            acquire(needsBeforeHook)
            acquire(needsBeforeHook)
            release(needsBeforeHook)

            legacyStorage.enterWith({})
            sinon.assert.calledOnce(onEnter)

            release(needsBeforeHook)
            assertUninstrumented()
          })
        })
      }

      it('should enable the async hook for a consumer acquiring after one that does not need it', async () => {
        acquire(false)
        acquire(true)
        await nextAsyncCallback()
        assert.ok(onBefore.called)
      })

      it('should disable the async hook once the last consumer needing it releases', async () => {
        acquire(false)
        acquire(true)
        release(true)

        await nextAsyncCallback()
        sinon.assert.notCalled(onBefore)
        legacyStorage.enterWith({})
        sinon.assert.calledOnce(onEnter)
      })

      it('should keep the async hook while a consumer needing it remains', async () => {
        acquire(true)
        acquire(false)
        release(false)

        await nextAsyncCallback()
        assert.ok(onBefore.called)
      })

      it('should leave a wrapper in place but inert when another wrapper was installed on top', () => {
        acquire(false)
        const ours = legacyStorage.enterWith
        const theirs = function (store) { return ours.call(this, store) }
        legacyStorage.enterWith = theirs

        release(false)
        assert.strictEqual(legacyStorage.enterWith, theirs)
        legacyStorage.enterWith({})
        sinon.assert.notCalled(onEnter)

        // Acquiring again reuses the existing wrapper instead of stacking another one.
        acquire(false)
        assert.strictEqual(legacyStorage.enterWith, theirs)
        legacyStorage.enterWith({})
        sinon.assert.calledOnce(onEnter)

        // Once the outer wrapper is gone, releasing can restore the original.
        legacyStorage.enterWith = ours
        release(false)
        assertUninstrumented()
      })

      it('should ignore unbalanced release', async () => {
        releaseChannels(true)
        acquire(true)
        legacyStorage.enterWith({})
        sinon.assert.calledOnce(onEnter)
        await nextAsyncCallback()
        assert.ok(onBefore.called)
      })

      it('should ignore a release claiming the async hook that was not acquired with it', async () => {
        acquire(false)
        acquire(false)
        // A bogus hook release must not underflow the hook count.
        releaseChannels(true)
        held = [false]

        acquire(true)
        await nextAsyncCallback()
        assert.ok(onBefore.called)
      })
    })
  }
})
