'use strict'

const { describe, it } = require('tap').mocha
const assert = require('node:assert')
const { join } = require('node:path')

require('../../setup/core')

const {
  getCallSites,
  parseUserLandFrames
} = require('../../../src/plugins/util/stacktrace')

describe('stacktrace utils', () => {
  it('should get callsites array from getCallsites', () => {
    const callsites = getCallSites()
    assert.strictEqual(Array.isArray(callsites), true)
    assert.strictEqual(callsites.length > 0, true)
    callsites.forEach((callsite) => {
      assert.strictEqual(callsite instanceof Object, true)
      assert.strictEqual(callsite.constructor.name, 'CallSite')
      assert.strictEqual(callsite.getFileName instanceof Function, true)
    })
  })

  describe('parse', () => {
    const nonUserLandFrame = `    at foo (${join(__dirname, 'node_modules', 'bar.js')}:123:456)`

    it('should bail on invalid stack', () => {
      assert.deepStrictEqual(parseUserLandFrames(genStackTrace('foo')), [])
    })

    describe('non-hardcoded stack traces', () => {
      it('should parse a frame', function outerFunction () {
        const lineNumber = getNextLineNumber()
        const { stack } = new Error('foo')
        const [frame] = parseUserLandFrames(stack)
        assert.deepStrictEqual(frame, {
          typeName: 'Test',
          functionName: 'outerFunction',
          methodName: undefined,
          fileName: __filename,
          lineNumber,
          columnNumber: '27'
        })
      })

      it('should parse frame with eval', () => {
        const lineNumber = getNextLineNumber()
        const { stack } = eval('new Error("foo")') // eslint-disable-line no-eval
        const [frame] = parseUserLandFrames(stack)
        assert.deepStrictEqual(frame, {
          typeName: undefined,
          functionName: 'eval',
          methodName: undefined,
          fileName: __filename,
          lineNumber,
          columnNumber: '27'
        })
      })

      function getNextLineNumber () {
        const stack = new Error('foo').stack.split('\n')
        return String(Number(stack[2].split(':').at(-2)) + 1)
      }
    })

    describe('should parse frame with location not wrapped in parentheses', () => {
      it('normal case', () => {
        assertStackTraceWithFrame('    at foo/bar/baz.js:123:456', {
          typeName: undefined,
          functionName: undefined,
          methodName: undefined,
          fileName: 'foo/bar/baz.js',
          lineNumber: '123',
          columnNumber: '456'
        })
      })

      it('with weird characters', () => {
        assertStackTraceWithFrame('    at      f[i](l<e>:.js:1:2)    :2:1', {
          typeName: undefined,
          functionName: undefined,
          methodName: undefined,
          fileName: '     f[i](l<e>:.js:1:2)    ',
          lineNumber: '2',
          columnNumber: '1'
        })
      })

      it('evalmachine.<anonymous>', () => {
        assertStackTraceWithFrame('    at evalmachine.<anonymous>:1:17', {
          typeName: undefined,
          functionName: undefined,
          methodName: undefined,
          fileName: 'evalmachine.<anonymous>',
          lineNumber: '1',
          columnNumber: '17'
        })
      })
    })

    it('should parse frame with a function name and a normal location', () => {
      assertStackTraceWithFrame('    at foo (/foo/bar/baz.js:123:456)', {
        typeName: undefined,
        functionName: 'foo',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '123',
        columnNumber: '456'
      })
    })

    it('should parse frame with a function name and a weird filename', () => {
      assertStackTraceWithFrame('    at foo (foo [bar] (baz).js:123:456)', {
        typeName: undefined,
        functionName: 'foo',
        methodName: undefined,
        fileName: 'foo [bar] (baz).js',
        lineNumber: '123',
        columnNumber: '456'
      })
    })

    it('should parse frame with a function name and a weird filename 2', () => {
      assertStackTraceWithFrame('    at x (     f[i](l<e>:.js:1:2)    :1:33)', {
        typeName: undefined,
        functionName: 'x',
        methodName: undefined,
        fileName: '     f[i](l<e>:.js:1:2)    ',
        lineNumber: '1',
        columnNumber: '33'
      })
    })

    it('should be able to parse file: paths', () => {
      assertStackTraceWithFrame('    at foo (file:///foo/bar/baz.js:123:456)', {
        typeName: undefined,
        functionName: 'foo',
        methodName: undefined,
        fileName: 'file:///foo/bar/baz.js',
        lineNumber: '123',
        columnNumber: '456'
      })
    })

    it('should be able to parse Windows paths', () => {
      assertStackTraceWithFrame('    at foo (D:\\foo\\bar\\baz.js:123:456)', {
        typeName: undefined,
        functionName: 'foo',
        methodName: undefined,
        fileName: 'D:\\foo\\bar\\baz.js',
        lineNumber: '123',
        columnNumber: '456'
      })
    })

    it('should parse frame with method name', () => {
      assertStackTraceWithFrame('    at foo [as bar] (/foo/bar/baz.js:3:8)', {
        typeName: undefined,
        functionName: 'foo',
        methodName: 'bar',
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with something that looks like a method name, but is not', () => {
      assertStackTraceWithFrame('    at foo [bar baz] (/foo/bar/baz.js:3:8)', {
        typeName: undefined,
        functionName: 'foo [bar baz]',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with a class name', () => {
      assertStackTraceWithFrame('    at Foo.bar (/foo/bar/baz.js:3:8)', {
        functionName: 'bar',
        methodName: undefined,
        typeName: 'Foo',
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with a class name and a method name', () => {
      assertStackTraceWithFrame('    at Foo.bar [as baz] (/foo/bar/baz.js:3:8)', {
        functionName: 'bar',
        methodName: 'baz',
        typeName: 'Foo',
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with whitespace in the function name', () => {
      assertStackTraceWithFrame('    at foo bar (/foo/bar/baz.js:3:8)', {
        typeName: undefined,
        functionName: 'foo bar',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with weird unicode characters', () => {
      const frame = '    at Object.asdf ][)( \u0000\u0001\u0002\u0003\u001b[44;37m foo (/foo/bar/baz.js:3:8)'
      assertStackTraceWithFrame(frame, {
        typeName: 'Object',
        functionName: 'asdf ][)( \u0000\u0001\u0002\u0003\u001b[44;37m foo',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame where the function name contains what looks like a location', () => {
      assertStackTraceWithFrame('    at Object.asdf (a/b.js:1:2) (c/d/e.js:3:4)', {
        typeName: 'Object',
        functionName: 'asdf (a/b.js:1:2)',
        methodName: undefined,
        lineNumber: '3',
        columnNumber: '4',
        fileName: 'c/d/e.js'
      })
    })

    it('should parse frame a class name and whitespace in the function name', () => {
      // { "foo bar" () { throw new Error() } }
      assertStackTraceWithFrame('    at Object.foo bar (/foo/bar/baz.js:3:8)', {
        typeName: 'Object',
        functionName: 'foo bar',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with a symbol as the function name', () => {
      assertStackTraceWithFrame('    at [Symbol.iterator] (/foo/bar/baz.js:3:8)', {
        typeName: undefined,
        functionName: '[Symbol.iterator]',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with a class name and a symbol as the function name', () => {
      // Array.from({ *[Symbol.iterator] () { throw new Error() } })
      assertStackTraceWithFrame('    at Object.[Symbol.iterator] (/foo/bar/baz.js:3:8)', {
        typeName: 'Object',
        functionName: '[Symbol.iterator]',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with a class name and function name with weird characters', () => {
      assertStackTraceWithFrame('    at Object.foo [a (b) [<z>]] (/foo/bar/baz.js:3:8)', {
        typeName: 'Object',
        functionName: 'foo [a (b) [<z>]]',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with an anonymous function', () => {
      assertStackTraceWithFrame('    at <anonymous> (/foo/bar/baz.js:3:8)', {
        typeName: undefined,
        functionName: '<anonymous>',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with a class name and an anonymous function', () => {
      assertStackTraceWithFrame('    at Object.<anonymous> (/foo/bar/baz.js:3:8)', {
        typeName: 'Object',
        functionName: '<anonymous>',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame with a class name and a period in the function name', () => {
      assertStackTraceWithFrame('    at Object.foo.bar (/foo/bar/baz.js:3:8)', {
        typeName: 'Object',
        functionName: 'foo.bar',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame that calls a constructor', () => {
      assertStackTraceWithFrame('    at new Foo (/foo/bar/baz.js:3:8)', {
        typeName: undefined,
        functionName: 'Foo',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    it('should parse frame that is async', () => {
      assertStackTraceWithFrame('    at async foo (/foo/bar/baz.js:3:8)', {
        typeName: undefined,
        functionName: 'foo',
        methodName: undefined,
        fileName: '/foo/bar/baz.js',
        lineNumber: '3',
        columnNumber: '8'
      })
    })

    describe('eval', () => {
      it('should parse frame with eval (normal case - anonymous)', () => {
        assertStackTraceWithFrame('    at eval (eval at <anonymous> (/foo/bar/baz.js:1:2), <anonymous>:3:4)', {
          lineNumber: '1',
          columnNumber: '2',
          fileName: '/foo/bar/baz.js',
          functionName: 'eval',
          methodName: undefined,
          typeName: undefined
        })
      })

      it('should parse frame with eval (normal case - not anonymous)', () => {
        assertStackTraceWithFrame('    at eval (eval at foo (/foo/bar/baz.js:1:2), <anonymous>:3:4)', {
          lineNumber: '1',
          columnNumber: '2',
          fileName: '/foo/bar/baz.js',
          functionName: 'eval',
          methodName: undefined,
          typeName: undefined
        })
      })

      it('should parse frame with eval (weird filename)', () => {
        assertStackTraceWithFrame('    at eval (eval at fooeval (a file with eval .js:1:2), <anonymous>:3:4)', {
          lineNumber: '1',
          columnNumber: '2',
          fileName: 'a file with eval .js',
          functionName: 'eval',
          methodName: undefined,
          typeName: undefined
        })
      })

      it('should parse frame with eval (normal case - nested eval)', () => {
        const frame = '    at eval (eval at <anonymous> (eval at D (/foo/bar/baz.js:1:2)), <anonymous>:3:4)'
        assertStackTraceWithFrame(frame, {
          lineNumber: '1',
          columnNumber: '2',
          fileName: '/foo/bar/baz.js',
          functionName: 'eval',
          methodName: undefined,
          typeName: undefined
        })
      })
    })

    it('should parse frame from native code', () => {
      assert.deepStrictEqual(parseUserLandFrames(genStackTrace('    at foo (native)')), [])
    })

    it('should parse frame from an unknown location', () => {
      assert.deepStrictEqual(parseUserLandFrames(genStackTrace('    at foo (unknown location)')), [])
    })

    it('should parse frame with an anonymous location', () => {
      assert.deepStrictEqual(parseUserLandFrames(genStackTrace('    at foo (<anonymous>)')), [])
    })

    it('should parse frame from an Node.js core', () => {
      assert.deepStrictEqual(parseUserLandFrames(genStackTrace('    at foo (node:vm:137:12)')), [])
    })

    it('should parse frame where filename that contains whitespace and parentheses', () => {
      assertStackTraceWithFrame('    at X.<anonymous> (/USER/Db (Person)/x/y.js:14:11)', {
        typeName: 'X',
        functionName: '<anonymous>',
        methodName: undefined,
        fileName: '/USER/Db (Person)/x/y.js',
        lineNumber: '14',
        columnNumber: '11'
      })
    })

    describe('user-land frame', () => {
      it('should should only return user-land frames', () => {
        const stack = genStackTraceWithManyNonUserLandFramesAnd(
          `    at foo (${join(__dirname, 'bar.js')}:123:456)`,
          `    at foo (${join(__dirname, 'baz.js')}:1:2)`
        )
        assert.deepStrictEqual(parseUserLandFrames(stack, Infinity), [{
          columnNumber: '456',
          fileName: join(__dirname, 'bar.js'),
          functionName: 'foo',
          lineNumber: '123',
          methodName: undefined,
          typeName: undefined
        }, {
          columnNumber: '2',
          fileName: join(__dirname, 'baz.js'),
          functionName: 'foo',
          lineNumber: '1',
          methodName: undefined,
          typeName: undefined
        }])
      })

      it('should return an emtpy array if there are no user-land frames', () => {
        const stack = genStackTraceWithManyNonUserLandFramesAnd(
          `    at foo (${join(__dirname, 'node_modules', 'bar.js')}:123:456)`
        )
        assert.deepStrictEqual(parseUserLandFrames(stack, Infinity), [])
      })
    })

    describe('limit', () => {
      it('should return the correct number of frames', () => {
        const stack = genStackTraceWithManyNonUserLandFramesAnd(
          `    at foo (${join(__dirname, 'bar.js')}:123:456)`,
          `    at foo (${join(__dirname, 'baz.js')}:1:2)`
        )
        assert.strictEqual(parseUserLandFrames(stack, 1).length, 1)
        assert.strictEqual(parseUserLandFrames(stack, 2).length, 2)
        assert.strictEqual(parseUserLandFrames(stack, 3).length, 2)
        assert.strictEqual(parseUserLandFrames(stack, 4).length, 2)
        assert.strictEqual(parseUserLandFrames(stack, 5).length, 2)
      })
    })

    function genStackTraceWithManyNonUserLandFramesAnd (...frames) {
      return `Error: multi\nline\n${nonUserLandFrame}\n${frames.join('\n')}\n${nonUserLandFrame}`
    }

    function genStackTrace (frameStr) {
      return `Error: multi\nline\n${frameStr}\n${frameStr}`
    }

    function assertStackTraceWithFrame (frame, expected) {
      assertStackTrace(parseUserLandFrames(genStackTrace(frame)), expected)
    }

    function assertStackTrace (frames, expected) {
      assert.strictEqual(frames.length, 2, 'Expected two stack frames, got ' + frames.length)
      assert.deepStrictEqual(frames[0], frames[1], 'Expected the two stack frames to be identical')
      assert.deepStrictEqual(frames[0], expected)
    }
  })
})
