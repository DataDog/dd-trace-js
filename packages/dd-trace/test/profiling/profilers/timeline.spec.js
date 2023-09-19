'use strict'

require('../../setup/tap')

const { ok } = require('assert')
const { expect } = require('chai')

describe('profilers/timeline', () => {
  const TimelineProfiler = require('../../../src/profiling/profilers/timeline')

  it('should summarize durations', () => {
    const profiler = new TimelineProfiler({samplingInterval: 100000000})
    // create a duration accumulator
    const { quanta: q } = profiler._createActivity('X')
    const expectedAccs = new Map()
    const expectedSpanData = new Map()
    const expectedQuanta = []
    expectedSpanData.set('X', expectedQuanta)
    expectedSpanData.rootSpanId = undefined
    expectedSpanData.ref = 1
    expectedAccs.set('', expectedSpanData)
    expect(profiler._accumulators).to.deep.equal(expectedAccs)

    // add first duration
    profiler._addDuration(q, 10, 20)
    expectedQuanta.push({'end': 100, 'duration': 10})
    expect(profiler._accumulators).to.deep.equal(expectedAccs)

    // add another duration into the same time quantum
    profiler._addDuration(q, 20, 35)
    expectedQuanta[0].duration += 15
    expect(profiler._accumulators).to.deep.equal(expectedAccs)

    // add a duration that spills over into a new later quantum
    profiler._addDuration(q, 80, 120)
    expectedQuanta[0].duration += 20
    expectedQuanta.push({'end': 200, 'duration': 20})
    expect(profiler._accumulators).to.deep.equal(expectedAccs)

    // add a duration that spills over into a new earlier quantum
    profiler._addDuration(q, -10, 10)
    expectedQuanta[0].duration += 10
    expectedQuanta.unshift({'end': 0, 'duration': 10})
    expect(profiler._accumulators).to.deep.equal(expectedAccs)

    // add a duration that creates a new quantum with space in between
    profiler._addDuration(q, 420, 440)
    expectedQuanta.push({'end': 500, 'duration': 20})
    expect(profiler._accumulators).to.deep.equal(expectedAccs)

    // add a duration that creates a new intermediate quantum to the left of an
    // existing one with overlap
    profiler._addDuration(q, 375, 410)
    expectedQuanta[3].duration += 10
    expectedQuanta.splice(3, 0, {'end': 400, 'duration': 25})
    expect(profiler._accumulators).to.deep.equal(expectedAccs)

    // add a duration that creates a new intermediate quantum to the right of an
    // existing one with overlap
    profiler._addDuration(q, 175, 210)
    expectedQuanta[2].duration += 25
    expectedQuanta.splice(3, 0, {'end': 300, 'duration': 10})
    expect(profiler._accumulators).to.deep.equal(expectedAccs)
  })

  it('should report durations', () => {
    const profiler = new TimelineProfiler({samplingInterval: 100000000})
    // Add few durations
    const { spanData, quanta: qx } = profiler._createActivity('X');
    profiler._addDuration(qx, 10, 20)
    profiler._addDuration(qx, 110, 130)
    profiler._addDuration(qx, 210, 240)
    profiler._addDuration(qx, 310, 350)

    // Dereference the span data
    spanData.ref--
    expect(spanData.ref).to.equal(0)

    const g1 = profiler._reportUntil(299)
    expect(g1.next()).to.deep.equal({value: { type: 'X', spanId: undefined, rootSpanId: undefined,
        quanta: [{end: 100, duration: 10}, {end:200, duration: 20}]
    }, done: false})
    expect(g1.next().done).to.equal(true)

    // Reported values have been removed
    expect(profiler._accumulators.get('').get('X')).to.deep.equal([{end: 300, duration: 30}, {end:400, duration: 40}])

    // report remaining data
    const g2 = profiler._reportUntil(500)
    expect(g2.next()).to.deep.equal({value: { type: 'X', spanId: undefined, rootSpanId: undefined,
        quanta: [{end: 300, duration: 30}, {end:400, duration: 40}]
    }, done: false})
    expect(g2.next().done).to.equal(true)
    // No data remains. The '' global "span" is not deleted even though it is
    // dereferenced.
    expect(profiler._accumulators.get('').get('X')).to.deep.equal([])
  })

  it('should delete unreferenced spans', () => {
    const profiler = new TimelineProfiler({samplingInterval: 100000000})
    // Add few durations
    const { spanData, quanta: qx } = profiler._createActivity('X', '1234567890');
    profiler._addDuration(qx, 10, 20)
    profiler._addDuration(qx, 110, 130)
    profiler._addDuration(qx, 210, 240)
    profiler._addDuration(qx, 310, 350)

    // Dereference the span data
    spanData.ref--
    expect(spanData.ref).to.equal(0)

    // Report some data
    const g1 = profiler._reportUntil(299)
    expect(g1.next()).to.deep.equal({value: { type: 'X', spanId: '1234567890', rootSpanId: undefined,
        quanta: [{end: 100, duration: 10}, {end:200, duration: 20}]
    }, done: false})
    expect(g1.next().done).to.equal(true)

    // Span data is not deleted despite being dereferenced as it still has data
    expect(profiler._accumulators.get('1234567890').get('X')).to.deep.equal([{end: 300, duration: 30}, {end:400, duration: 40}])

    // report remaining data
    const g2 = profiler._reportUntil(500)
    expect(g2.next()).to.deep.equal({value: { type: 'X', spanId: '1234567890', rootSpanId: undefined,
        quanta: [{end: 300, duration: 30}, {end:400, duration: 40}]
    }, done: false})
    expect(g2.next().done).to.equal(true)
    // No data remains, span data was deleted
    expect(profiler._accumulators).to.deep.equal(new Map())
  })

  it('should add partial activity durations when reporting', () => {
    const profiler = new TimelineProfiler({samplingInterval: 100000000})
    // Add few durations
    const activity1 = profiler._createActivity('X', '1');
    profiler._active.set(1, activity1)
    const activity2 = profiler._createActivity('X', '2')
    profiler._active.set(2, activity2)
    const activity3 = profiler._createActivity('X', '1');
    profiler._active.set(3, activity3)
    const activity4 = profiler._createActivity('X', '2');
    profiler._active.set(4, activity4)
    // These will add to durations, but not running when reporting
    profiler._startActivity(activity3, 10)
    profiler._stopActivity(activity3, 30)
    profiler._startActivity(activity4, 10)
    profiler._stopActivity(activity4, 40)
    // These two will be running when reporting
    profiler._startActivity(activity1, 50)
    profiler._startActivity(activity2, 110)
    const g1 = profiler._reportUntil(111) // reported until 100 quanta
    // duration 70, as activity3 added 20, and activity1 added 50 until 100
    expect(g1.next()).to.deep.equal({value: { type: 'X', spanId: '1', rootSpanId: undefined,
        quanta: [{end: 100, duration: 70}]
    }, done: false})
    // duration 30, as activity4 added it. activity2 not reported as it started
    // after 100 quanta
    expect(g1.next()).to.deep.equal({value: { type: 'X', spanId: '2', rootSpanId: undefined,
        quanta: [{end: 100, duration: 30}]
    }, done: false})
    expect(activity1.running).to.be.true
    expect(activity1.start).to.equal(100)
    expect(activity2.running).to.be.true
    expect(activity2.start).to.equal(110)
    expect(activity3.running).to.be.false
    expect(activity4.running).to.be.false
  })
})
