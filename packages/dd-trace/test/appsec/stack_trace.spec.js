'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const { reportStackTrace, getCallsiteFrames } = require('../../src/appsec/stack_trace')

describe('Stack trace reporter', () => {
  describe('frame filtering', () => {
    it('should filter out frames from library', () => {
      const callSiteList =
        Array(10).fill().map((_, i) => (
          {
            getFileName: () => path.join(__dirname, `file${i}`),
            getLineNumber: () => i,
            getColumnNumber: () => i,
            getFunctionName: () => `libraryFunction${i}`,
            getTypeName: () => `LibraryClass${i}`,
            isNative: () => false,
          }
        )).concat(
          Array(10).fill().map((_, i) => (
            {
              getFileName: () => `file${i}`,
              getLineNumber: () => i,
              getColumnNumber: () => i,
              getFunctionName: () => `function${i}`,
              getTypeName: () => `Class${i}`,
              isNative: () => false,
            }
          ))
        ).concat([
          {
            getFileName: () => null,
            getLineNumber: () => null,
            getColumnNumber: () => null,
            getFunctionName: () => null,
            getTypeName: () => null,
            isNative: () => false,
          },
        ])

      const expectedFrames = Array(10).fill().map((_, i) => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `Class${i}`,
          isNative: false,
        }
      ))
        .concat([
          {
            id: 10,
            file: null,
            line: null,
            column: null,
            function: null,
            class_name: null,
            isNative: false,
          },
        ])

      const maxDepth = 32
      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      assert.deepStrictEqual(frames, expectedFrames)
    })
  })

  describe('report stack traces', () => {
    const callSiteList = Array(20).fill().map((_, i) => (
      {
        getFileName: () => `file${i}`,
        getLineNumber: () => i,
        getColumnNumber: () => i,
        getFunctionName: () => `function${i}`,
        getTypeName: () => `type${i}`,
        isNative: () => false,
      }
    ))

    it('should not fail if no root span is passed', () => {
      const rootSpan = undefined
      const stackId = 'test_stack_id'
      try {
        reportStackTrace(rootSpan, stackId, callSiteList)
      } catch {
        assert.fail()
      }
    })

    it('should append a stack trace through the span API', () => {
      const calls = []
      const rootSpan = {
        appendStackTrace (...args) {
          calls.push(args)
          return true
        },
      }
      const stackId = 'test_stack_id'
      const maxDepth = 32
      const expectedFrames = Array(20).fill().map((_, i) => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `type${i}`,
          isNative: false,
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      const appended = reportStackTrace(rootSpan, stackId, frames)

      assert.strictEqual(appended, true)
      assert.deepStrictEqual(calls, [[
        'exploit',
        {
          id: stackId,
          language: 'nodejs',
          frames: expectedFrames,
        },
        0,
      ]])
    })

    it('should pass the namespace and cap to the span API', () => {
      const calls = []
      const rootSpan = {
        appendStackTrace (...args) {
          calls.push(args)
          return false
        },
      }
      const stackId = 'test_stack_id'
      const frames = [{ file: 'test.js' }]

      const appended = reportStackTrace(rootSpan, stackId, frames, 'vulnerability', 2)

      assert.strictEqual(appended, false)
      assert.deepStrictEqual(calls, [[
        'vulnerability',
        {
          id: stackId,
          language: 'nodejs',
          frames,
        },
        2,
      ]])
    })

    it('should not report stackTraces if callSiteList is undefined', () => {
      const rootSpan = {
        appendStackTrace: () => assert.fail(),
      }
      const stackId = 'test_stack_id'

      assert.strictEqual(reportStackTrace(rootSpan, stackId, undefined), undefined)
    })
  })

  describe('limit stack traces frames', () => {
    const callSiteList = Array(120).fill().map((_, i) => (
      {
        getFileName: () => `file${i}`,
        getLineNumber: () => i,
        getColumnNumber: () => i,
        getFunctionName: () => `function${i}`,
        getTypeName: () => `type${i}`,
        isNative: () => false,
      }
    ))

    it('limit frames to max depth', () => {
      const maxDepth = 5
      const expectedFrames = [0, 1, 2, 118, 119].map(i => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `type${i}`,
          isNative: false,
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      assert.deepStrictEqual(frames, expectedFrames)
    })

    it('limit frames to max depth with filtered frames', () => {
      const maxDepth = 5
      const callSiteListWithLibraryFrames = [
        {
          getFileName: () => path.join(__dirname, 'firstFrame'),
          getLineNumber: () => 314,
          getColumnNumber: () => 271,
          getFunctionName: () => 'libraryFunction',
          getTypeName: () => 'libraryType',
          isNative: () => false,
        },
      ].concat(Array(120).fill().map((_, i) => (
        {
          getFileName: () => `file${i}`,
          getLineNumber: () => i,
          getColumnNumber: () => i,
          getFunctionName: () => `function${i}`,
          getTypeName: () => `type${i}`,
          isNative: () => false,
        }
      )).concat([
        {
          getFileName: () => path.join(__dirname, 'lastFrame'),
          getLineNumber: () => 271,
          getColumnNumber: () => 314,
          getFunctionName: () => 'libraryFunction',
          getTypeName: () => 'libraryType',
          isNative: () => false,
        },
      ]))
      const expectedFrames = [0, 1, 2, 118, 119].map(i => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `type${i}`,
          isNative: false,
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteListWithLibraryFrames)

      assert.deepStrictEqual(frames, expectedFrames)
    })

    it('no limit if maxDepth is 0', () => {
      const maxDepth = 0
      const expectedFrames = Array(120).fill().map((_, i) => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `type${i}`,
          isNative: false,
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      assert.deepStrictEqual(frames, expectedFrames)
    })

    it('no limit if maxDepth is negative', () => {
      const maxDepth = -1
      const expectedFrames = Array(120).fill().map((_, i) => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `type${i}`,
          isNative: false,
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      assert.deepStrictEqual(frames, expectedFrames)
    })
  })
})
