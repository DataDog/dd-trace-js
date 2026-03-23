'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { FakeCiVisIntake } = require('../ci-visibility-intake')

describe('FakeCiVisIntake', () => {
  it('should reject with a timeout error and remove the listener', async () => {
    const intake = new FakeCiVisIntake()

    await assert.rejects(
      intake.assertPayloadReceived(() => {}, undefined, 5),
      {
        message: 'timeout',
      }
    )
    assert.strictEqual(intake.listenerCount('message'), 0)
  })

  it('should resolve when a matching payload satisfies the assertion', async () => {
    const intake = new FakeCiVisIntake()
    const payloadPromise = intake.assertPayloadReceived(({ payload }) => {
      assert.deepStrictEqual(payload, { ok: true })
    }, ({ url }) => url === '/expected')

    intake.emit('message', {
      payload: { ok: true },
      url: '/expected',
    })

    await payloadPromise
    assert.strictEqual(intake.listenerCount('message'), 0)
  })
})
