'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const SpeechActivity = require('../../src/elevenlabs/activity')

/**
 * @param {SpeechActivity} activity
 * @param {number} duration
 * @param {number} now
 */
function intervals (activity, duration, now = duration) {
  return activity.metadata(duration, now)?.intervals_ms
}

describe('ElevenLabs VAD activity', () => {
  it('uses entry/exit hysteresis at the exact thresholds', () => {
    const activity = new SpeechActivity()
    activity.observe(0.35, 0, 0)
    activity.observe(0.499, 100, 100)
    activity.observe(0.5, 200, 200)
    activity.observe(0.351, 300, 300)
    activity.observe(0.35, 400, 400)
    assert.deepEqual(intervals(activity, 500), [[200, 400]])
  })
  it('preserves unobserved samples during sparse deliveries and input gaps', () => {
    const activity = new SpeechActivity()
    activity.observe(0.1, 0, 0)
    activity.observe(0.1, 700, 100)
    assert.deepEqual(intervals(activity, 800, 200), [[500, 700]])
    const sparse = new SpeechActivity()
    sparse.observe(0.1, 0, 0)
    sparse.observe(0.1, 200, 700)
    assert.deepEqual(intervals(sparse, 300, 800), [[0, 200]])
  })
  it('does not extend stale silence through shutdown', () => {
    const activity = new SpeechActivity()
    activity.observe(0.1, 0, 0)
    assert.deepEqual(intervals(activity, 500, 500), [])
    assert.deepEqual(intervals(activity, 501, 501), [[500, 501]])
  })
  it('ignores invalid and reversed observations', () => {
    const activity = new SpeechActivity()
    for (const score of [undefined, null, false, '0.1', NaN, Infinity, -0.01, 1.01]) activity.observe(score, 0, 0)
    assert.equal(intervals(activity, 100), undefined)
    activity.observe(0.1, 100, 100)
    activity.observe(0.9, 50, 200)
    activity.observe(0.9, 200, 50)
    assert.deepEqual(intervals(activity, 300), [[0, 100]])
  })
  it('transfers state across turn boundaries and shutdown extension', () => {
    const first = new SpeechActivity()
    first.observe(0.1, 0, 0)
    first.observe(0.1, 100, 100)
    const next = first.continueAt(100)
    next.observe(0.9, 100, 200)
    next.observe(0.1, 200, 300)
    first.extend(next, 100, 100)
    assert.deepEqual(intervals(first, 400, 400), [[200, 300]])
  })
  it('rounds outward and merges touching millisecond regions', () => {
    const activity = new SpeechActivity()
    activity.observe(0.1, 0.2, 0)
    activity.observe(0.9, 1.2, 1)
    activity.observe(0.1, 2.2, 2)
    activity.observe(0.9, 2.8, 3)
    assert.deepEqual(intervals(activity, 3.2, 4), [[0, 4]])
  })
  it('falls back after interval overflow instead of exporting a partial activity map', () => {
    const activity = new SpeechActivity()
    for (let i = 0; i < 128; i++) {
      activity.observe(0.1, i * 20, i * 20)
      activity.observe(0.9, i * 20 + 10, i * 20 + 10)
    }
    const observed = intervals(activity, 2560)
    assert.ok(observed)
    assert.equal(observed.length, 128)
    activity.observe(0.1, 2560, 2560)
    activity.observe(0.9, 2570, 2570)
    assert.equal(intervals(activity, 2600), undefined)
  })
})
