'use strict'

const { assert } = require('chai')
const path = require('path')

const {
  cutDownFrames,
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
            getLineNumber: () => `${i}`,
            getColumnNumber: () => `${i}`,
            getFunctionName: () => `function${i}`
          }
        )
        ).concat(
          [...Array(10).keys()].map(i => (
            {
              getFileName: () => `file${i}`,
              getLineNumber: () => `${i}`,
              getColumnNumber: () => `${i}`,
              getFunctionName: () => `function${i}`
            }
          ))
        )

      const expectedFrames = [...Array(10).keys()].map(i => (
        {
          file: `file${i}`,
          line: `${i}`,
          column: `${i}`,
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

  describe('cutDownFrames', () => {
    const frames = [...Array(120).keys()].map(i => (
      {
        id: i,
        file: `file${i}`,
        line: `${i}`,
        column: `${i}`,
        function: `function${i}`
      }
    ))

    it('cut down frames to max depth', () => {
      const expectedFrames = [0, 1, 2, 118, 119].map(i => (
        {
          id: i,
          file: `file${i}`,
          line: `${i}`,
          column: `${i}`,
          function: `function${i}`
        }
      ))

      const shortenedFrameList = cutDownFrames(frames, 5)
      assert.deepEqual(shortenedFrameList, expectedFrames)
    })

    it('cut down to 100 if max depth is greater than 100', () => {
      const expectedFrames = [...Array(50).keys()].map(i => (
        {
          id: i,
          file: `file${i}`,
          line: `${i}`,
          column: `${i}`,
          function: `function${i}`
        }
      )).concat(
        [...Array(50).keys()].map(i => (
          {
            id: i + 70,
            file: `file${i + 70}`,
            line: `${i + 70}`,
            column: `${i + 70}`,
            function: `function${i + 70}`
          }
        ))
      )

      const shortenedFrameList = cutDownFrames(frames, 120)
      assert.deepEqual(shortenedFrameList, expectedFrames)
    })

    it('cut down to 100 if max depth is 0', () => {
      const expectedFrames = [...Array(50).keys()].map(i => (
        {
          id: i,
          file: `file${i}`,
          line: `${i}`,
          column: `${i}`,
          function: `function${i}`
        }
      )).concat(
        [...Array(50).keys()].map(i => (
          {
            id: i + 70,
            file: `file${i + 70}`,
            line: `${i + 70}`,
            column: `${i + 70}`,
            function: `function${i + 70}`
          }
        ))
      )

      const shortenedFrameList = cutDownFrames(frames, 0)
      assert.deepEqual(shortenedFrameList, expectedFrames)
    })

    it('cut down to 100 if max depth is negative', () => {
      const expectedFrames = [...Array(50).keys()].map(i => (
        {
          id: i,
          file: `file${i}`,
          line: `${i}`,
          column: `${i}`,
          function: `function${i}`
        }
      )).concat(
        [...Array(50).keys()].map(i => (
          {
            id: i + 70,
            file: `file${i + 70}`,
            line: `${i + 70}`,
            column: `${i + 70}`,
            function: `function${i + 70}`
          }
        ))
      )

      const shortenedFrameList = cutDownFrames(frames, -1)
      assert.deepEqual(shortenedFrameList, expectedFrames)
    })
  })

  describe('reportStackTrace', () => {
    const callSiteList = [...Array(20).keys()].map(i => (
      {
        getFileName: () => `file${i}`,
        getLineNumber: () => `${i}`,
        getColumnNumber: () => `${i}`,
        getFunctionName: () => `function${i}`
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
      reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

      const expectedFrames = callSiteList.map((callSite, i) => (
        {
          id: i,
          file: callSite.getFileName(),
          line: callSite.getLineNumber(),
          column: callSite.getColumnNumber(),
          function: callSite.getFunctionName()
        }
      ))

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
      reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

      const expectedFrames = callSiteList.map((callSite, i) => (
        {
          id: i,
          file: callSite.getFileName(),
          line: callSite.getLineNumber(),
          column: callSite.getColumnNumber(),
          function: callSite.getFunctionName()
        }
      ))

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
      reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

      const expectedFrames = callSiteList.map((callSite, i) => (
        {
          id: i,
          file: callSite.getFileName(),
          line: callSite.getLineNumber(),
          column: callSite.getColumnNumber(),
          function: callSite.getFunctionName()
        }
      ))

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
          }
        }
      }
      const stackId = 'test_stack_id'
      const maxDepth = 32
      reportStackTrace(rootSpan, stackId, maxDepth, 2, () => callSiteList)

      assert.equal(rootSpan.meta_struct['_dd.stack'].exploit.length, 2)
    })
  })
})
