'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
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
      sinon.assert.calledTwice(log)
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

    for (const [name, character] of [['two-byte', 'é'], ['three-byte', '漢'], ['four-byte', '😀']]) {
      describe(`with ${name} UTF-8 characters`, () => {
        it('should split batches by byte size without losing spans', () => {
          const spans = Array.from({ length: 3 }, () => ({ tag: character.repeat(12000) }))
          log = sinon.stub(process.stdout, 'write')
          try {
            exporter.export(spans)
          } finally {
            log.restore()
          }

          const lines = log.args.map(([line]) => line)
          assert.ok(lines.length > 1)
          for (const line of lines) {
            assert.ok(Buffer.byteLength(line, 'utf8') <= 64 * 1024)
          }
          assert.deepEqual(lines.flatMap(line => JSON.parse(line).traces[0]), spans)
        })

        it('should accept a span whose framed payload is exactly the byte limit', () => {
          const overhead = Buffer.byteLength('{"traces":[[{"tag":""}]]}\n', 'utf8')
          const budget = 64 * 1024 - overhead
          const characterSize = Buffer.byteLength(character, 'utf8')
          const count = Math.floor(budget / characterSize)
          const padding = budget - count * characterSize
          span.tag = character.repeat(count) + 'a'.repeat(padding)
          log = sinon.stub(process.stdout, 'write')
          try {
            exporter.export([span, span])
          } finally {
            log.restore()
          }

          sinon.assert.calledTwice(log)
          for (const [line] of log.args) {
            assert.equal(Buffer.byteLength(line, 'utf8'), 64 * 1024)
            assert.deepEqual(JSON.parse(line).traces[0], [span])
          }
        })

        it('should drop a span one byte over the limit without dropping surrounding spans', () => {
          const overhead = Buffer.byteLength('{"traces":[[{"tag":""}]]}\n', 'utf8')
          const budget = 64 * 1024 - overhead
          const characterSize = Buffer.byteLength(character, 'utf8')
          const count = Math.floor(budget / characterSize)
          const padding = budget - count * characterSize
          const oversized = { tag: character.repeat(count) + 'a'.repeat(padding + 1) }
          const small = { tag: 'small' }
          log = sinon.stub(process.stdout, 'write')
          try {
            exporter.export([small, oversized, small])
          } finally {
            log.restore()
          }

          sinon.assert.calledOnce(log)
          assert.deepEqual(JSON.parse(log.firstCall.args[0]).traces[0], [small, small])
        })
      })
    }
  })
})
