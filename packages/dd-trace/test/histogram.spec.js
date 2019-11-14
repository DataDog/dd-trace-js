'use strict'

const Histogram = require('../src/histogram')

describe('Histogram', () => {
  let histogram

  beforeEach(() => {
    histogram = new Histogram()
  })

  it('should record values', () => {
    histogram.record(1)
    histogram.record(2)
    histogram.record(3)

    expect(histogram).to.have.property('min', 1)
    expect(histogram).to.have.property('max', 3)
    expect(histogram).to.have.property('sum', 6)
    expect(histogram).to.have.property('avg', 2)
    expect(histogram).to.have.property('median', 2)
    expect(histogram).to.have.property('count', 3)
    expect(histogram).to.have.property('p95', 3)
    expect(histogram.percentile(50)).to.equal(2)
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
