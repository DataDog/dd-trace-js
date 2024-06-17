'use strict'

const { assert } = require('chai')
const path = require('path')

const {
  filterOutFramesFromLibrary,
  reportStackTrace
} = require('../../src/appsec/stack_trace')

describe('Stack trace reporter', () => {
  describe('filterOutFramesFromLibrary', () => {
    it('should filer out frames from library', () => {
      const callSiteList =
        [...Array(10).keys()].map(i => (
          {
            getFileName: () => path.join(__dirname, `file${i}`),
            getLineNumber: () => i,
            getColumnNumber: () => i,
            getFunctionName: () => `function${i}`
          }
        )
        ).concat(
          [...Array(10).keys()].map(i => (
            {
              getFileName: () => `file${i}`,
              getLineNumber: () => i,
              getColumnNumber: () => i,
              getFunctionName: () => `function${i}`
            }
          ))
        )

      const expectedFrames = [...Array(10).keys()].map(i => (
        {
          file: `file${i}`,
          line: i,
          column: i,
          function: `function${i}`
        }
      ))

      const filteredFrames = filterOutFramesFromLibrary(callSiteList).map(frame => (
        {
          file: frame.getFileName(),
          line: frame.getLineNumber(),
          column: frame.getColumnNumber(),
          function: frame.getFunctionName()
        }
      ))

      assert.deepEqual(filteredFrames, expectedFrames)
    })
  })

  describe('reportStackTrace', () => {
    describe('report stack traces', () => {
      const callSiteList = [...Array(20).keys()].map(i => (
        {
          getFileName: () => `file${i}`,
          getLineNumber: () => i,
          getColumnNumber: () => i,
          getFunctionName: () => `function${i}`,
          getTypeName: () => `type${i}`
        }
      ))

      it('should not fail if no root span is passed', () => {
        const rootSpan = undefined
        const stackId = 'test_stack_id'
        const maxDepth = 32
        try {
          reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)
        } catch (e) {
          assert.fail()
        }
      })

      it('should add stack trace to rootSpan when meta_struct is not present', () => {
        const rootSpan = {}
        const stackId = 'test_stack_id'
        const maxDepth = 32
        const expectedFrames = [...Array(20).keys()].map(i => (
          {
            id: i,
            file: `file${i}`,
            line: i,
            column: i,
            function: `function${i}`,
            class_name: `type${i}`
          }
        ))

        reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

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
        const expectedFrames = [...Array(20).keys()].map(i => (
          {
            id: i,
            file: `file${i}`,
            line: i,
            column: i,
            function: `function${i}`,
            class_name: `type${i}`
          }
        ))

        reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

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
        const expectedFrames = [...Array(20).keys()].map(i => (
          {
            id: i,
            file: `file${i}`,
            line: i,
            column: i,
            function: `function${i}`,
            class_name: `type${i}`
          }
        ))

        reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

        assert.strictEqual(rootSpan.meta_struct['_dd.stack'].exploit[1].id, stackId)
        assert.strictEqual(rootSpan.meta_struct['_dd.stack'].exploit[1].language, 'nodejs')
        assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[1].frames, expectedFrames)
        assert.property(rootSpan.meta_struct, 'another_tag')
      })

      it('should not report stack trace when the maximum has been reached', () => {
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

        reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

        assert.equal(rootSpan.meta_struct['_dd.stack'].exploit.length, 2)
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

        reportStackTrace(rootSpan, stackId, maxDepth, 0, () => callSiteList)

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

        reportStackTrace(rootSpan, stackId, maxDepth, -1, () => callSiteList)

        assert.equal(rootSpan.meta_struct['_dd.stack'].exploit.length, 3)
        assert.property(rootSpan.meta_struct, 'another_tag')
      })
    })

    describe('limit stack traces frames', () => {
      const callSiteList = [...Array(120).keys()].map(i => (
        {
          getFileName: () => `file${i}`,
          getLineNumber: () => i,
          getColumnNumber: () => i,
          getFunctionName: () => `function${i}`,
          getTypeName: () => `type${i}`
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
            class_name: `type${i}`
          }
        ))

        reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

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
            getTypeName: () => 'libraryType'
          }
        ].concat([...Array(120).keys()].map(i => (
          {
            getFileName: () => `file${i}`,
            getLineNumber: () => i,
            getColumnNumber: () => i,
            getFunctionName: () => `function${i}`,
            getTypeName: () => `type${i}`
          }
        )).concat([
          {
            getFileName: () => path.join(__dirname, 'lastFrame'),
            getLineNumber: () => 271,
            getColumnNumber: () => 314,
            getFunctionName: () => 'libraryFunction',
            getTypeName: () => 'libraryType'
          }
        ]))
        const expectedFrames = [0, 1, 2, 118, 119].map(i => (
          {
            id: i,
            file: `file${i}`,
            line: i,
            column: i,
            function: `function${i}`,
            class_name: `type${i}`
          }
        ))

        reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteListWithLibraryFrames)

        assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].frames, expectedFrames)
      })

      it('no limit if maxDepth is 0', () => {
        const rootSpan = {}
        const stackId = 'test_stack_id'
        const maxDepth = 0
        const expectedFrames = [...Array(120).keys()].map(i => (
          {
            id: i,
            file: `file${i}`,
            line: i,
            column: i,
            function: `function${i}`,
            class_name: `type${i}`
          }
        ))

        reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

        assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].frames, expectedFrames)
      })

      it('no limit if maxDepth is negative', () => {
        const rootSpan = {}
        const stackId = 'test_stack_id'
        const maxDepth = -1
        const expectedFrames = [...Array(120).keys()].map(i => (
          {
            id: i,
            file: `file${i}`,
            line: i,
            column: i,
            function: `function${i}`,
            class_name: `type${i}`
          }
        ))

        reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

        assert.deepEqual(rootSpan.meta_struct['_dd.stack'].exploit[0].frames, expectedFrames)
      })
    })
  })
})
