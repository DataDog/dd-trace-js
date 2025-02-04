'use strict'

require('../../setup/mocha')

describe('findScriptFromPartialPath', function () {
  let state

  const cases = [
    ['file:///path/to/foo.js', 'script-id-posix'],
    ['file:///C:/path/to/bar.js', 'script-id-win-slash'],
    // We have no evidence that Chrome DevTools Protocol uses backslashes in paths, but test in case it changes
    ['file:///C:\\path\\to\\baz.js', 'script-id-win-backslash']
  ]

  before(function () {
    state = proxyquire('../src/debugger/devtools_client/state', {
      './session': {
        '@noCallThru': true,
        on (event, listener) {
          if (event === 'Debugger.scriptParsed') {
            cases.forEach(([url, scriptId]) => {
              listener({ params: { scriptId, url } })
            })

            // Test case for when there's multiple partial matches
            listener({ params: { scriptId: 'should-match', url: 'file:///server/index.js' } })
            listener({ params: { scriptId: 'should-not-match', url: 'file:///index.js' } })

            // Test case for when there's two equal length partial matches
            listener({ params: { scriptId: 'should-not-match-longest-a', url: 'file:///node_modules/foo/index.js' } })
            listener({ params: { scriptId: 'should-match-shortest-a', url: 'file:///foo/index.js' } })
            // The same, but in reverse order to ensure this doesn't influence the result
            listener({ params: { scriptId: 'should-match-shortest-b', url: 'file:///bar/index.js' } })
            listener({ params: { scriptId: 'should-not-match-longest-b', url: 'file:///node_modules/bar/index.js' } })
          }
        }
      }
    })
  })

  for (const [url, scriptId] of cases) {
    const filename = url.includes('\\') ? url.split('\\').pop() : url.split('/').pop()

    describe(`targeting ${url}`, function () {
      describe('POSIX paths', function () {
        describe('full path matches', function () {
          it('with a "file:" protocol', testPath(`file:///path/to/${filename}`))

          it('with a root slash', testPath(`/path/to/${filename}`))

          it('without a root slash', testPath(`path/to/${filename}`))
        })

        describe('partial path matches', function () {
          it('fewer directories', testPath(`to/${filename}`))

          it('no directories', testPath(filename))
        })

        describe('path contains directory prefix', function () {
          it('prefixed with unknown directory', testPath(`prefix/to/${filename}`))

          it('prefixed with two unknown directories', testPath(`prefix1/prefix2/to/${filename}`))
        })

        describe('case insensitive', function () {
          it('should match if the path is in lowercase', testPath(filename.toLowerCase()))

          it('should match if the path is in uppercase', testPath(filename.toUpperCase()))
        })

        describe('non-matching paths', function () {
          it('should not match if only part of a directory matches (at boundary)',
            testPathNoMatch(`path/o/${filename}`))

          it('should not match if only part of a directory matches (not at boundary)',
            testPathNoMatch(`path/no/${filename}`))

          it('should not match if only part of a directory matches (root)', testPathNoMatch(`o/${filename}`))

          it('should not match if only part of a file matches', testPathNoMatch(filename.slice(1)))
        })
      })

      describe('Windows paths', function () {
        describe('with backslashes', function () {
          describe('full path matches', function () {
            it('with a "file:" protocol', testPath(`file:///C|\\path\\to\\${filename}`))

            it('with a drive letter', testPath(`C:\\path\\to\\${filename}`))

            it('without a drive slash', testPath(`C:path\\to\\${filename}`))
          })

          describe('partial path matches', function () {
            it('fewer directories', testPath(`to\\${filename}`))
          })

          describe('path contains directory prefix', function () {
            it('prefixed with unknown directory', testPath(`prefix\\to\\${filename}`))

            it('prefixed with two unknown directories', testPath(`prefix1\\prefix2\\to\\${filename}`))
          })
        })

        describe('with forward slashes', function () {
          describe('full path matches', function () {
            it('with a "file:" protocol', testPath(`file:///C|/path/to/${filename}`))

            it('with a drive letter', testPath(`C:/path/to/${filename}`))

            it('without a drive slash', testPath(`C:path/to/${filename}`))
          })
        })
      })
    })

    function testPath (path) {
      return function () {
        const result = state.findScriptFromPartialPath(path)
        expect(result).to.deep.equal([url, scriptId, undefined])
      }
    }
  }

  describe('multiple partial matches', function () {
    it('should match the longest partial match', function () {
      const result = state.findScriptFromPartialPath('server/index.js')
      expect(result).to.deep.equal(['file:///server/index.js', 'should-match', undefined])
    })

    it('should match the shorter of two equal length partial matches', function () {
      const result1 = state.findScriptFromPartialPath('foo/index.js')
      expect(result1).to.deep.equal(['file:///foo/index.js', 'should-match-shortest-a', undefined])

      const result2 = state.findScriptFromPartialPath('bar/index.js')
      expect(result2).to.deep.equal(['file:///bar/index.js', 'should-match-shortest-b', undefined])
    })
  })

  describe('should abort if the path is', function () {
    it('unknown', testPathNoMatch('this/path/does/not/exist.js'))

    it('undefined', testPathNoMatch(undefined))

    it('an empty string', testPathNoMatch(''))

    it('a slash', testPathNoMatch('/'))

    it('a backslash', testPathNoMatch('\\'))

    it('a Windows drive letter', testPathNoMatch('c:'))

    it('a Windows drive letter with a backslash', testPathNoMatch('c:\\'))
  })

  function testPathNoMatch (path) {
    return function () {
      const result = state.findScriptFromPartialPath(path)
      expect(result).to.be.null
    }
  }
})
