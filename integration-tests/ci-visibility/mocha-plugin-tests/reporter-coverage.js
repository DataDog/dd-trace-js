'use strict'

describe('mocha-coverage-reporter', () => {
  it('keeps coverage visible to suite reporters', () => {
    global.__coverage__ = {
      [__filename]: {
        path: __filename,
        statementMap: {
          0: {
            start: { line: 4, column: 2 },
            end: { line: 4, column: 3 },
          },
        },
        fnMap: {},
        branchMap: {},
        s: { 0: 1 },
        f: {},
        b: {},
      },
    }
  })
})
