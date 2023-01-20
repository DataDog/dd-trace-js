'use strict'

const { expect } = require('chai')
const { ConflatedCombiner, AggregatedCombiner, Point } = require('../../../src/appsec/telemetry/combiners')

describe('Telemetry Combiners', () => {
  describe('ConflatedCombiner', () => {
    it('should increment value and set value = 0 when invoking drain', () => {
      const conflated = new ConflatedCombiner()
      conflated.add(5)

      expect(conflated.value).to.be.eq(5)

      const points = conflated.drain()

      expect(conflated.value).to.be.eq(0)
      expect(points.length).to.be.eq(1)
      expect(points[0].value).to.be.eq(5)
    })

    it('should merge another metricData points', () => {
      const conflated = new ConflatedCombiner()
      conflated.add(5)

      const metricData = {
        points: [new Point(5), new Point(5)]
      }

      conflated.merge(metricData)

      const points = conflated.drain()

      expect(points.length).to.be.eq(1)
      expect(points[0].value).to.be.eq(15)
    })
  })

  describe('AggregatedCombiner', () => {
    it('should add new point to value and set value = [] when invoking drain', () => {
      const aggregated = new AggregatedCombiner()
      aggregated.add(5)

      expect(aggregated.value).to.be.an.instanceof(Array)
      expect(aggregated.value.length).to.be.eq(1)
      expect(aggregated.value[0]).to.be.an.instanceOf(Point)

      const points = aggregated.drain()

      expect(aggregated.value.length).to.be.eq(0)

      expect(points).to.be.an.instanceof(Array)
      expect(points.length).to.be.eq(1)
      expect(points[0]).to.be.an.instanceOf(Point)
      expect(points[0].value).to.be.eq(5)
    })

    it('should merge another metricData points', () => {
      const aggregated = new AggregatedCombiner()
      aggregated.add(5)

      const metricData = {
        points: [new Point(7)]
      }

      aggregated.merge(metricData)

      const points = aggregated.drain()

      expect(points.length).to.be.eq(2)
      expect(points[0].value).to.be.eq(5)
      expect(points[1].value).to.be.eq(7)
    })
  })
})
