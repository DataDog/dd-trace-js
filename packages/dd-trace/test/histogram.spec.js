'use strict'

require('./setup/tap')

const Histogram = require('../src/histogram')

describe('Histogram', () => {
  let histogram

  beforeEach(() => {
    histogram = new Histogram()
  })

  it('should record values', () => {
    for (let i = 1; i < 100; i++) {
      histogram.record(i)
    }

    const median = histogram.median
    const p50 = histogram.percentile(50)
    const p95 = histogram.percentile(95)

    expect(histogram).to.have.property('min', 1)
    expect(histogram).to.have.property('max', 99)
    expect(histogram).to.have.property('sum', 4950)
    expect(histogram).to.have.property('avg', 50)
    expect(histogram).to.have.property('median')
    expect(histogram).to.have.property('count', 99)
    expect(histogram).to.have.property('p95')
    expect(median).to.be.gte(49)
    expect(median).to.be.lte(51)
    expect(p50).to.be.gte(49)
    expect(p50).to.be.lte(51)
    expect(p95).to.be.gte(94)
    expect(p95).to.be.lte(96)
  })

  it('should reset all stats', () => {
    histogram.record(1)
    histogram.record(2)
    histogram.record(3)

    histogram.reset()

    expect(histogram).to.have.property('min', 0)
    expect(histogram).to.have.property('max', 0)
    expect(histogram).to.have.property('sum', 0)
    expect(histogram).to.have.property('avg', 0)
    expect(histogram).to.have.property('median', 0)
    expect(histogram).to.have.property('count', 0)
    expect(histogram).to.have.property('p95', 0)
    expect(histogram.percentile(50)).to.equal(0)
  })
})
