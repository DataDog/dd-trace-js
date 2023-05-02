'use strict'

const { expect } = require('chai')
const {
  DefaultHandler,
  TaggedHandler,
  DelegatingHandler,
  MetricData,
  CompositeTaggedHandler
} = require('../../../src/appsec/telemetry/handlers')
const { Point, AggregatedCombiner, ConflatedCombiner } = require('../../../src/appsec/telemetry/combiners')
const { EXECUTED_PROPAGATION, REQUEST_TAINTED } = require('../../../src/appsec/iast/iast-metric')
const { Metric } = require('../../../src/appsec/telemetry/metric')

function getCombiner (point) {
  return {
    add: sinon.spy(),
    drain: sinon.stub().returns([point]),
    merge: sinon.spy()
  }
}

describe('Telemetry Handlers', () => {
  const point = new Point(5)
  let combinersCreated
  let combiner
  let supplier
  beforeEach(() => {
    combiner = getCombiner(point)
    combinersCreated = []
    supplier = () => {
      const combiner = getCombiner(point)
      combinersCreated.push(combiner)
      return combiner
    }
  })
  const metric = {
    name: 'test.metric',
    serialize: (points, tag) => new MetricData(metric, points, tag)
  }
  const taggedMetric = {
    name: 'test.metric',
    tag: 'testTag',
    serialize: (points, tag) => new MetricData(taggedMetric, points, tag)
  }

  describe('MetricData', () => {
    it('should call metric.getPoint for each point to obtain the payload points', () => {
      const p1 = {}
      const p2 = {}
      const points = [p1, p2]
      const metric = {
        getPoint: sinon.stub()
      }
      const data = new MetricData(metric, points, 'tag')
      data.getPayloadPoints(points)

      expect(metric.getPoint).to.be.calledTwice
      expect(metric.getPoint.firstCall.args[0]).to.eq(p1)
      expect(metric.getPoint.secondCall.args[0]).to.eq(p2)
    })
  })

  describe('DefaultHandler', () => {
    it('should invoke add combiner with value', () => {
      const defaultHandler = new DefaultHandler(metric, combiner)
      defaultHandler.add(5)

      expect(combiner.add).to.be.calledOnceWith(5)
    })

    it('should invoke combiner.drain and return a MetricData[]', () => {
      const defaultHandler = new DefaultHandler(metric, combiner)
      defaultHandler.add(5)

      const metricDataList = defaultHandler.drain()
      expect(metricDataList.length).to.eq(1)

      const metricData = metricDataList[0]
      expect(metricData).to.be.an.instanceOf(MetricData)
      expect(metricData.metric).to.eq(metric)
      expect(metricData.points.length).to.eq(1)
      expect(metricData.points[0]).to.eq(point)
    })

    it('should invoke combiner.merge', () => {
      const defaultHandler = new DefaultHandler(metric, combiner)
      defaultHandler.add(5)

      const datas = [{}]

      defaultHandler.merge(datas)
      expect(combiner.merge).to.be.calledOnceWith(datas)
    })

    it('should delegate in metric.serialize when draining data to obtain MetricData', () => {
      const metric = {
        serialize: sinon.stub()
      }
      const defaultHandler = new DefaultHandler(metric, combiner)
      defaultHandler.add(5)

      defaultHandler.drain()
      expect(metric.serialize).to.be.calledOnceWithExactly([point])
    })
  })

  describe('TaggedHandler', () => {
    it('should initialize a combiner for a tag and store it', () => {
      const taggedHandler = new TaggedHandler(taggedMetric, supplier)
      taggedHandler.add(5, 'this_is_a_tag')

      expect(combinersCreated.length).to.eq(1)
      expect(taggedHandler.combiners.size).to.eq(1)
      expect(taggedHandler.combiners.has('this_is_a_tag')).to.be.true
      expect(taggedHandler.combiners.get('this_is_a_tag')).to.eq(combinersCreated[0])

      expect(combinersCreated[0].add).to.be.calledOnceWith(5)
    })

    it('should reuse a combiner for a tag', () => {
      const taggedHandler = new TaggedHandler(taggedMetric, supplier)
      taggedHandler.add(5, 'this_is_a_tag')
      taggedHandler.add(10, 'this_is_a_tag')

      expect(combinersCreated.length).to.eq(1)
      expect(taggedHandler.combiners.size).to.eq(1)

      expect(combinersCreated[0].add).to.be.calledTwice
    })

    it('should initialize a combiner for each tag', () => {
      const taggedHandler = new TaggedHandler(taggedMetric, supplier)
      taggedHandler.add(5, 'this_is_a_tag')
      taggedHandler.add(10, 'this_is_a_different_tag')

      expect(combinersCreated.length).to.eq(2)
      expect(taggedHandler.combiners.size).to.eq(2)

      expect(combinersCreated[0].add).to.be.calledOnceWith(5)
      expect(combinersCreated[1].add).to.be.calledOnceWith(10)
    })

    it('should use empty string when no tag is provided to add', () => {
      const taggedHandler = new TaggedHandler(taggedMetric, supplier)
      taggedHandler.add(5)

      expect(combinersCreated.length).to.eq(1)
      expect(taggedHandler.combiners.size).to.eq(1)
      expect(taggedHandler.combiners.has('')).to.be.true
    })

    it('should drain all combiners and set MetricData correct tag', () => {
      const taggedHandler = new TaggedHandler(taggedMetric, supplier)
      taggedHandler.add(5, 'this_is_a_tag')
      taggedHandler.add(10, 'this_is_a_different_tag')

      const metricDataList = taggedHandler.drain()

      expect(combinersCreated[0].drain).to.be.calledOnce
      expect(combinersCreated[1].drain).to.be.calledOnce

      expect(metricDataList.length).to.eq(2)

      expect(metricDataList[0].metric).to.equal(taggedMetric)
      expect(metricDataList[0].tag).to.equal('this_is_a_tag')

      expect(metricDataList[1].metric).to.equal(taggedMetric)
      expect(metricDataList[1].tag).to.equal('this_is_a_different_tag')
    })

    it('should delegate in metric.serialize when draining data to obtain MetricData', () => {
      const taggedMetric = {
        serialize: sinon.stub()
      }
      const taggedHandler = new TaggedHandler(taggedMetric, supplier)
      taggedHandler.add(5, 'this_is_a_tag')

      taggedHandler.drain()
      expect(taggedMetric.serialize).to.be.calledOnceWithExactly([point], 'this_is_a_tag')
    })

    it('should merge metricData which same tag if match', () => {
      const taggedHandler = new TaggedHandler(taggedMetric, supplier)
      taggedHandler.add(5, 'this_is_a_tag')
      taggedHandler.add(10, 'this_is_a_different_tag')

      const metricData = {
        points: [new Point(7)],
        tag: 'this_is_a_different_tag'
      }
      taggedHandler.merge(metricData)

      expect(combinersCreated[1].merge).to.be.calledOnceWith(metricData)
    })

    it('should merge metricData whith unknown tag', () => {
      const taggedHandler = new TaggedHandler(taggedMetric, supplier)
      taggedHandler.add(5, 'this_is_a_tag')
      taggedHandler.add(10, 'this_is_a_different_tag')

      const metricData = {
        points: [new Point(7)],
        tag: 'this_is_another_tag'
      }
      taggedHandler.merge(metricData)

      expect(combinersCreated.length).to.eq(3)
      expect(combinersCreated[2].merge).to.be.calledOnceWith(metricData)
      expect(taggedHandler.combiners.has('this_is_another_tag')).to.be.true
    })

    it('should support metrics with multiple tags', () => {
      class CustomMetric extends Metric {
        constructor (name, scope, metricTag, namespace, tags) {
          super(name, scope, metricTag, namespace)
          this.customTags = [...tags]
        }

        getTags (tag) {
          const tags = super.getTags(tag)
          tags.push(...this.customTags)
          return tags
        }
      }

      const custom = new CustomMetric('custom', 'TEST', 'metricTag', 'test_namespace', ['tag1:value1', 'tag2:value2'])

      const taggedHandler = new TaggedHandler(custom, supplier)
      taggedHandler.add(5, 'this_is_a_tag')
      const metricDatas = taggedHandler.drain()

      expect(metricDatas.length).to.eq(1)
      expect(metricDatas[0].getTags()).to.be.deep.eq(['metricTag:this_is_a_tag', 'tag1:value1', 'tag2:value2'])
    })

    it('should return original tag', () => {
      const taggedHandler = new TaggedHandler(taggedMetric, supplier)
      taggedHandler.add(5, 'this_is_a_tag')
      expect(taggedHandler.getMetricDataTag('this_is_a_tag')).to.eq('this_is_a_tag')
    })
  })

  describe('DelegatingHandler', () => {
    it('should invoke collector.addMetric combiner with metric, value and tag', () => {
      const collector = {
        addMetric: sinon.spy()
      }
      const delegatingHandler = new DelegatingHandler(taggedMetric, collector)
      delegatingHandler.add(5, 'this_is_a_tag')

      expect(collector.addMetric).to.be.calledOnceWith(taggedMetric, 5, 'this_is_a_tag')
    })
  })

  describe('CompositeTaggedHandler', () => {
    const compositeTag = {
      version: '0.0.1',
      blocked: false,
      key: () => {
        return `version:${compositeTag.version},blocked:${compositeTag.blocked}`
      }
    }
    const differentCompositeTag = {
      version: '0.0.2',
      blocked: true,
      key: () => {
        return `version:${differentCompositeTag.version},blocked:${differentCompositeTag.blocked}`
      }
    }

    const tag = compositeTag.key()

    const compositeTaggedMetric = {
      name: 'composite.metric',
      serialize: (points, tag) => new MetricData(compositeTaggedMetric, points, tag)
    }

    it('should initialize a combiner for a composite tag and store it', () => {
      const taggedHandler = new CompositeTaggedHandler(compositeTaggedMetric, supplier)
      taggedHandler.add(5, compositeTag)

      expect(combinersCreated.length).to.eq(1)
      expect(taggedHandler.combiners.size).to.eq(1)
      expect(taggedHandler.combiners.has(tag)).to.be.true
      expect(taggedHandler.combiners.get(tag)).to.eq(combinersCreated[0])

      expect(combinersCreated[0].add).to.be.calledOnceWith(5)
    })

    it('should initialize a combiner for a string tag and store it', () => {
      const taggedHandler = new CompositeTaggedHandler(compositeTaggedMetric, supplier)
      const tag = 'this_is_a_tag'
      taggedHandler.add(5, tag)

      expect(combinersCreated.length).to.eq(1)
      expect(taggedHandler.combiners.size).to.eq(1)
      expect(taggedHandler.combiners.has(tag)).to.be.true
      expect(taggedHandler.combiners.get(tag)).to.eq(combinersCreated[0])

      expect(combinersCreated[0].add).to.be.calledOnceWith(5)
    })

    it('should reuse a combiner for a tag', () => {
      const taggedHandler = new CompositeTaggedHandler(compositeTaggedMetric, supplier)
      taggedHandler.add(5, compositeTag)
      taggedHandler.add(10, compositeTag)

      expect(combinersCreated.length).to.eq(1)
      expect(taggedHandler.combiners.size).to.eq(1)

      expect(combinersCreated[0].add).to.be.calledTwice
    })

    it('should reuse a combiner for a tag with same key', () => {
      const taggedHandler = new CompositeTaggedHandler(compositeTaggedMetric, supplier)

      const compositeTagWithSameKey = {
        key: () => {
          return `version:0.0.1,blocked:false`
        }
      }

      taggedHandler.add(5, compositeTag)
      taggedHandler.add(10, compositeTagWithSameKey)

      expect(combinersCreated.length).to.eq(1)
      expect(taggedHandler.combiners.size).to.eq(1)

      expect(combinersCreated[0].add).to.be.calledTwice
    })

    it('should initialize a combiner for each tag', () => {
      const taggedHandler = new CompositeTaggedHandler(compositeTaggedMetric, supplier)
      taggedHandler.add(5, compositeTag)
      taggedHandler.add(10, differentCompositeTag)

      expect(combinersCreated.length).to.eq(2)
      expect(taggedHandler.combiners.size).to.eq(2)

      expect(combinersCreated[0].add).to.be.calledOnceWith(5)
      expect(combinersCreated[1].add).to.be.calledOnceWith(10)
    })

    it('should use empty string when no tag is provided to add', () => {
      const taggedHandler = new CompositeTaggedHandler(compositeTaggedMetric, supplier)
      taggedHandler.add(5)

      expect(combinersCreated.length).to.eq(1)
      expect(taggedHandler.combiners.size).to.eq(1)
      expect(taggedHandler.combiners.has('')).to.be.true
    })

    it('should drain all combiners and set MetricData correct tag', () => {
      const taggedHandler = new CompositeTaggedHandler(compositeTaggedMetric, supplier)
      taggedHandler.add(5, compositeTag)
      taggedHandler.add(10, differentCompositeTag)

      const metricDataList = taggedHandler.drain()

      expect(combinersCreated[0].drain).to.be.calledOnce
      expect(combinersCreated[1].drain).to.be.calledOnce

      expect(metricDataList.length).to.eq(2)

      expect(metricDataList[0].metric).to.equal(compositeTaggedMetric)
      expect(metricDataList[0].tag).to.equal(compositeTag)

      expect(metricDataList[1].metric).to.equal(compositeTaggedMetric)
      expect(metricDataList[1].tag).to.equal(differentCompositeTag)
    })

    it('should merge metricData which same tag if match', () => {
      const taggedHandler = new CompositeTaggedHandler(compositeTaggedMetric, supplier)
      taggedHandler.add(5, compositeTag)
      taggedHandler.add(10, differentCompositeTag)

      const metricData = {
        points: [new Point(7)],
        tag: differentCompositeTag
      }
      taggedHandler.merge(metricData)

      expect(combinersCreated[1].merge).to.be.calledOnceWith(metricData)
    })

    it('should merge metricData whith unknown tag', () => {
      const taggedHandler = new CompositeTaggedHandler(compositeTaggedMetric, supplier)
      taggedHandler.add(5, compositeTag)
      taggedHandler.add(10, differentCompositeTag)

      const anotherTag = {
        version: '0.0.2',
        blocked: false,
        key: () => {
          return `version:${anotherTag.version},blocked:${anotherTag.blocked}`
        }
      }

      const metricData = {
        points: [new Point(7)],
        tag: anotherTag
      }
      taggedHandler.merge(metricData)

      expect(combinersCreated.length).to.eq(3)
      expect(combinersCreated[2].merge).to.be.calledOnceWith(metricData)
      expect(taggedHandler.combiners.has(anotherTag.key())).to.be.true
    })

    it('should return original tag by its key', () => {
      const taggedHandler = new CompositeTaggedHandler(compositeTaggedMetric, supplier)
      taggedHandler.add(5, compositeTag)

      expect(taggedHandler.getMetricDataTag(compositeTag.key())).to.eq(compositeTag)
    })
  })

  describe('handlers', () => {
    it('aggregated should return a TaggedHandler when invoked on a metric with tag', () => {
      const handler = EXECUTED_PROPAGATION.aggregated()

      expect(handler).to.not.be.undefined
      expect(handler).to.be.an.instanceOf(TaggedHandler)
      expect(handler.supplier()).to.be.an.instanceOf(AggregatedCombiner)
    })

    it('aggregated should return a DefaultHandler when invoked on a metric without tag', () => {
      const handler = REQUEST_TAINTED.aggregated()

      expect(handler).to.not.be.undefined
      expect(handler).to.be.an.instanceOf(DefaultHandler)
      expect(handler.combiner).to.be.an.instanceOf(AggregatedCombiner)
    })

    it('conflated should return a TaggedHandler when invoked on a metric with tag', () => {
      const handler = EXECUTED_PROPAGATION.conflated()

      expect(handler).to.not.be.undefined
      expect(handler).to.be.an.instanceOf(TaggedHandler)
      expect(handler.supplier()).to.be.an.instanceOf(ConflatedCombiner)
    })

    it('conflated should return a DefaultHandler when invoked on a metric without tag', () => {
      const handler = REQUEST_TAINTED.conflated()

      expect(handler).to.not.be.undefined
      expect(handler).to.be.an.instanceOf(DefaultHandler)
      expect(handler.combiner).to.be.an.instanceOf(ConflatedCombiner)
    })

    it('delegating should return a DelegatingHandler', () => {
      const collector = {}
      const handler = REQUEST_TAINTED.delegating(collector)

      expect(handler).to.not.be.undefined
      expect(handler).to.be.an.instanceOf(DelegatingHandler)
      expect(handler.collector).to.eq(collector)
    })
  })
})
