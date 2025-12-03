'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

describe('LogExporter', () => {
  let Exporter
  let exporter
  let span
  let log

  beforeEach(() => {
    span = { tag: 'test' }

    Exporter = proxyquire('../../../src/exporters/log', {})
    exporter = new Exporter()
  })

  describe('export', () => {
    it('should flush its traces to the console', () => {
      log = sinon.stub(process.stdout, 'write')
      exporter.export([span, span])
      log.restore()
      const result = '{"traces":[[{"tag":"test"},{"tag":"test"}]]}'
      sinon.assert.calledWithMatch(log, result)
    })

    it('should send spans over multiple log lines when they are too large for a single log line', () => {
      //  64kb is the limit for a single log line. We create a span that matches that length exactly.
      const expectedPrefix = '{"traces":[[{"tag":"'
      const expectedSuffix = '"}]]}\n'
      span.tag = new Array(64 * 1024 - expectedPrefix.length - expectedSuffix.length).fill('a').join('')
      log = sinon.stub(process.stdout, 'write')
      exporter.export([span, span])
      log.restore()
      const result = `${expectedPrefix}${span.tag}${expectedSuffix}`
      expect(log).to.have.calledTwice
      sinon.assert.calledWithMatch(log, result)
    })

    it('should drop spans if they are too large for a single log line', () => {
      //  64kb is the limit for a single log line. We create a span that exceeds that by 1 byte
      const expectedPrefix = '{"traces":[[{"tag":"'
      const expectedSuffix = '"}]]}\n'
      span.tag = new Array(64 * 1024 - expectedPrefix.length - expectedSuffix.length + 1).fill('a').join('')
      log = sinon.stub(process.stdout, 'write')
      exporter.export([span, span])
      log.restore()
      sinon.assert.notCalled(log)
    })
  })

  describe('process tags', () => {
    const { TRACING_FIELD_NAME } = require('../../../src/process-tags')
    const processTagsValue = 'entrypoint.name:test,entrypoint.type:script'

    beforeEach(() => {
      span = { meta: { tag: 'test' } }
      Exporter = proxyquire('../../../src/exporters/log', {})
      exporter = new Exporter()
      exporter._processTags = processTagsValue
    })

    it('should add process tags to first span only', () => {
      const span1 = { meta: { tag1: 'value1' } }
      const span2 = { meta: { tag2: 'value2' } }
      const span3 = { meta: { tag3: 'value3' } }

      log = sinon.stub(process.stdout, 'write')
      exporter.export([span1, span2, span3])
      log.restore()

      // First span should have process tags
      expect(span1.meta[TRACING_FIELD_NAME]).to.equal(processTagsValue)
      expect(span1.meta.tag1).to.equal('value1')
      
      // Other spans should not have process tags
      expect(span2.meta[TRACING_FIELD_NAME]).to.be.undefined
      expect(span3.meta[TRACING_FIELD_NAME]).to.be.undefined
    })

    it('should not add process tags if not configured', () => {
      const exporter2 = new Exporter()
      // Don't set _processTags
      const span1 = { meta: { tag1: 'value1' } }
      
      log = sinon.stub(process.stdout, 'write')
      exporter2.export([span1])
      log.restore()
      
      expect(span1.meta[TRACING_FIELD_NAME]).to.be.undefined
    })

    it('should add process tags to first span of each export call', () => {
      const span1 = { meta: { tag1: 'value1' } }
      const span2 = { meta: { tag2: 'value2' } }

      log = sinon.stub(process.stdout, 'write')
      
      // First export
      exporter.export([span1])
      expect(span1.meta[TRACING_FIELD_NAME]).to.equal(processTagsValue)
      
      // Second export - should not add process tags since we already added them once
      exporter.export([span2])
      expect(span2.meta[TRACING_FIELD_NAME]).to.be.undefined
      
      log.restore()
    })
  })
})
