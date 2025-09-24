'use strict'

const { assert } = require('chai')
const path = require('path')

const { reportStackTrace, getCallsiteFrames } = require('../../src/appsec/stack-trace')

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
            isNative: () => false
          }
        )).concat(
          Array(10).fill().map((_, i) => (
            {
              getFileName: () => `file${i}`,
              getLineNumber: () => i,
              getColumnNumber: () => i,
              getFunctionName: () => `function${i}`,
              getTypeName: () => `Class${i}`,
              isNative: () => false
            }
          ))
        ).concat([
          {
            getFileName: () => null,
            getLineNumber: () => null,
            getColumnNumber: () => null,
            getFunctionName: () => null,
            getTypeName: () => null,
            isNative: () => false
          }
        ])

      const expectedFrames = Array(10).fill().map((_, i) => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `Class${i}`,
          isNative: false
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
            isNative: false
          }
        ])

      const rootSpan = {}
      const stackId = 'test_stack_id'
      const maxDepth = 32
      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      reportStackTrace(rootSpan, stackId, frames)

      assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].frames, expectedFrames)
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
        isNative: () => false
      }
    ))

    it('should not fail if no root span is passed', () => {
      const rootSpan = undefined
      const stackId = 'test_stack_id'
      try {
        reportStackTrace(rootSpan, stackId, callSiteList)
      } catch (e) {
        assert.fail()
      }
    })

    it('should add stack trace to rootSpan when meta_struct is not present', () => {
      const rootSpan = {}
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
          isNative: false
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      reportStackTrace(rootSpan, stackId, frames)

      assert.strictEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].id, stackId)
      assert.strictEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].language, 'nodejs')
      assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].frames, expectedFrames)
    })

    it('should add stack trace to rootSpan when meta_struct is already present', () => {
      const rootSpan = {
        meta_struct: {
          another_tag: []
        }
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
          isNative: false
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      reportStackTrace(rootSpan, stackId, frames)

      assert.strictEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].id, stackId)
      assert.strictEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].language, 'nodejs')
      assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].frames, expectedFrames)
      assert.property(rootSpan.meta_struct, 'another_tag')
    })

    it('should add stack trace to rootSpan when meta_struct is already present and contains another stack', () => {
      const rootSpan = {
        meta_struct: {
          another_tag: [],
          '_dd.stack': {
            exploit: [callSiteList]
          }
        }
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
          isNative: false
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      reportStackTrace(rootSpan, stackId, frames)

      assert.strictEqual(rootSpan.meta_struct['_dd.stack'].exploit[1].id, stackId)
      assert.strictEqual(rootSpan.meta_struct['_dd.stack'].exploit[1].language, 'nodejs')
      assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[1].frames, expectedFrames)
      assert.property(rootSpan.meta_struct, 'another_tag')
    })

    it('should add stack trace when the max stack trace is 0', () => {
      const rootSpan = {
        meta_struct: {
          '_dd.stack': {
            exploit: [callSiteList, callSiteList]
          },
          another_tag: []
        }
      }
      const stackId = 'test_stack_id'
      const maxDepth = 32

      const frames = getCallsiteFrames(maxDepth, () => callSiteList)

      reportStackTrace(rootSpan, stackId, frames)

      assert.equal(rootSpan.meta_struct['_dd.stack'].exploit.length, 3)
      assert.property(rootSpan.meta_struct, 'another_tag')
    })

    it('should add stack trace when the max stack trace is negative', () => {
      const rootSpan = {
        meta_struct: {
          '_dd.stack': {
            exploit: [callSiteList, callSiteList]
          },
          another_tag: []
        }
      }
      const stackId = 'test_stack_id'
      const maxDepth = 32

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      reportStackTrace(rootSpan, stackId, frames)

      assert.equal(rootSpan.meta_struct['_dd.stack'].exploit.length, 3)
      assert.property(rootSpan.meta_struct, 'another_tag')
    })

    it('should not report stackTraces if callSiteList is undefined', () => {
      const rootSpan = {
        meta_struct: {
          another_tag: []
        }
      }
      const stackId = 'test_stack_id'
      reportStackTrace(rootSpan, stackId, undefined)
      assert.property(rootSpan.meta_struct, 'another_tag')
      assert.notProperty(rootSpan.meta_struct, '_dd.stack')
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
        isNative: () => false
      }
    ))

    it('limit frames to max depth', () => {
      const rootSpan = {}
      const stackId = 'test_stack_id'
      const maxDepth = 5
      const expectedFrames = [0, 1, 2, 118, 119].map(i => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `type${i}`,
          isNative: false
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      reportStackTrace(rootSpan, stackId, frames)

      assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].frames, expectedFrames)
    })

    it('limit frames to max depth with filtered frames', () => {
      const rootSpan = {}
      const stackId = 'test_stack_id'
      const maxDepth = 5
      const callSiteListWithLibraryFrames = [
        {
          getFileName: () => path.join(__dirname, 'firstFrame'),
          getLineNumber: () => 314,
          getColumnNumber: () => 271,
          getFunctionName: () => 'libraryFunction',
          getTypeName: () => 'libraryType',
          isNative: () => false
        }
      ].concat(Array(120).fill().map((_, i) => (
        {
          getFileName: () => `file${i}`,
          getLineNumber: () => i,
          getColumnNumber: () => i,
          getFunctionName: () => `function${i}`,
          getTypeName: () => `type${i}`,
          isNative: () => false
        }
      )).concat([
        {
          getFileName: () => path.join(__dirname, 'lastFrame'),
          getLineNumber: () => 271,
          getColumnNumber: () => 314,
          getFunctionName: () => 'libraryFunction',
          getTypeName: () => 'libraryType',
          isNative: () => false
        }
      ]))
      const expectedFrames = [0, 1, 2, 118, 119].map(i => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `type${i}`,
          isNative: false
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteListWithLibraryFrames)

      reportStackTrace(rootSpan, stackId, frames)

      assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].frames, expectedFrames)
    })

    it('no limit if maxDepth is 0', () => {
      const rootSpan = {}
      const stackId = 'test_stack_id'
      const maxDepth = 0
      const expectedFrames = Array(120).fill().map((_, i) => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `type${i}`,
          isNative: false
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      reportStackTrace(rootSpan, stackId, frames)

      assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].frames, expectedFrames)
    })

    it('no limit if maxDepth is negative', () => {
      const rootSpan = {}
      const stackId = 'test_stack_id'
      const maxDepth = -1
      const expectedFrames = Array(120).fill().map((_, i) => (
        {
          id: i,
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`,
          class_name: `type${i}`,
          isNative: false
        }
      ))

      const frames = getCallsiteFrames(maxDepth, getCallsiteFrames, () => callSiteList)

      reportStackTrace(rootSpan, stackId, frames)

      assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].frames, expectedFrames)
    })
  })
})
