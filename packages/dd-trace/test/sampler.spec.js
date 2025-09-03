'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')

require('./setup/tap')

const SpanContext = require('../src/opentracing/span_context')
const id = require('../src/id')

describe('Sampler', () => {
  let Sampler
  let sampler

  beforeEach(() => {
    sinon.stub(Math, 'random')
    Sampler = require('../src/sampler')
  })

  afterEach(() => {
    Math.random.restore()
  })

  describe('rate', () => {
    it('should return the sample rate', () => {
      sampler = new Sampler(0.5)

      expect(sampler.rate()).to.equal(0.5)
    })
  })

  describe('threshold', () => {
    it('should calculate the correct threshold for a given rate', () => {
      const rates = [
        [0.2, 3689348814741910528n],
        [0.25, 4611686018427387904n],
        [0.3333, 6148299799767393280n],
        [0.5, 9223372036854775808n],
        [0.75, 13835058055282163712n],
        [0.9, 16602069666338596864n],
        [0.95, 17524406870024073216n]
      ]

      rates.forEach(([rate, expected]) => {
        sampler = new Sampler(rate)
        expect(sampler.threshold).to.equal(expected)
      })
    })
  })

  describe('isSampled', () => {
    it('should always sample when rate is 1', () => {
      sampler = new Sampler(1)

      expect(sampler.isSampled(new SpanContext({ traceId: id() }))).to.be.true
    })

    it('should never sample when rate is 0', () => {
      sampler = new Sampler(0)

      expect(sampler.isSampled(new SpanContext({ traceId: id() }))).to.be.false
    })

    it('should sample according to the rate', () => {
      sampler = new Sampler(0.1234)

      expect(sampler.isSampled(new SpanContext({ traceId: id('8135292307740797052', 10) }))).to.be.true
      expect(sampler.isSampled(new SpanContext({ traceId: id('2263640730249415707', 10) }))).to.be.false
    })

    it('should sample according to different rates', () => {
      const idsAndRates = [
        [id('9223372036854775808', 10), 0.5, true],
        [id('9223372036854775808', 10), 0.25, false],
        [id('6148299799767393280', 10), 0.3333, false],
        [id('2986627970102095326', 10), 0.3333, true],
        [id('12078589664685934330', 10), 0.5, false],
        [id('13835058055282163712', 10), 0.75, true],
        [id('13835058055282163712', 10), 1, true],
        // Test random very large traceIDs
        [id('18444899399302180860', 10), 0.5, false],
        [id('18444899399302180861', 10), 0.5, false],
        [id('18444899399302180862', 10), 0.5, true],
        [id('18444899399302180863', 10), 0.5, true],
        // Test boundary values
        [id('18446744073709551615', 10), 0.5, false], // 2**64-1
        [id('9223372036854775809', 10), 0.5, false], // 2**63+1
        [id('9223372036854775807', 10), 0.5, true], // 2**63-1
        [id('4611686018427387905', 10), 0.5, false], // 2**62+1
        [id('4611686018427387903', 10), 0.5, false], // 2**62-1
        // Random traceIDs
        [id('646771306295669658', 10), 0.5, true],
        [id('1882305164521835798', 10), 0.5, true],
        [id('5198373796167680436', 10), 0.5, false],
        [id('6272545487220484606', 10), 0.5, true],
        [id('8696342848850656916', 10), 0.5, true],
        [id('10197320802478874805', 10), 0.5, true],
        [id('10350218024687037124', 10), 0.5, true],
        [id('12078589664685934330', 10), 0.5, false],
        [id('13794769880582338323', 10), 0.5, true],
        [id('14629469446186818297', 10), 0.5, false]
      ]

      idsAndRates.forEach(([id, rate, expected]) => {
        const sampler = new Sampler(rate)
        expect(sampler.isSampled(new SpanContext({ traceId: id }))).to.equal(expected)
      })
    })
  })
})
