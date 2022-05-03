'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')

const realFS = Object.assign({}, require('fs'))
const os = require('os')
const path = require('path')
const semver = require('semver')
const rimraf = require('rimraf')
const util = require('util')

const hasWritev = semver.satisfies(process.versions.node, '>=12.9.0')
const hasOSymlink = realFS.constants.O_SYMLINK

// TODO remove skips

describe('Plugin', () => {
  describe('fs', () => {
    let fs
    let tmpdir
    let tracer
    afterEach(() => agent.close())
    beforeEach(() => agent.load('fs').then(() => {
      tracer = require('../../dd-trace')
      fs = require('fs')
    }))
    before(() => {
      tmpdir = realFS.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-js-test'))
    })
    after((done) => {
      rimraf(tmpdir, realFS, done)
    })

    describe('without parent span', () => {
      describe('open', () => {
        it('should not be instrumented', (done) => {
          agent.use(() => {
            expect.fail('should not have been any traces')
          }).catch(done)

          setTimeout(done, 1500) // allow enough time to ensure no traces happened

          fs.open(__filename, 'r+', (err, fd) => {
            if (err) {
              done(err)
            } else {
              realFS.closeSync(fd)
            }
          })
        })
      })
    })

    describe('with parent span', () => {
      beforeEach((done) => {
        const parentSpan = tracer.startSpan('parent')
        parentSpan.finish()
        tracer.scope().activate(parentSpan, done)
      })

      describe('open', () => {
        let fd
        afterEach(() => {
          if (typeof fd === 'number') {
            realFS.closeSync(fd)
            fd = undefined
          }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource: 'open',
            meta: {
              'file.flag': 'r',
              'file.path': __filename
            }
          })

          fs.open(__filename, (err, _fd) => {
            fd = _fd
            if (err) done(err)
          })
        })

        it('should be instrumented with flags', (done) => {
          expectOneSpan(agent, done, {
            resource: 'open',
            meta: {
              'file.flag': 'r+',
              'file.path': __filename
            }
          })

          fs.open(__filename, 'r+', (err, _fd) => {
            fd = _fd
            if (err) done(err)
          })
        })

        it('should handle errors', (done) => {
          const filename = path.join(__filename, Math.random().toString())
          fs.open(filename, 'r', (err) => {
            expectOneSpan(agent, done, {
              resource: 'open',
              error: 0,
              meta: {
                'file.flag': 'r',
                'file.path': filename
              }
            })
          })
        })
      })

      if (realFS.promises) {
        describe('promises.open', () => {
          let fd
          afterEach(() => {
            if (typeof fd === 'number') {
              realFS.closeSync(fd)
              fd = undefined
            }
          })

          it('should be instrumented', (done) => {
            expectOneSpan(agent, done, {
              resource: 'promises.open',
              meta: {
                'file.flag': 'r',
                'file.path': __filename
              }
            })

            fs.promises.open(__filename).then(_fd => {
              fd = _fd
            }, done)
          })

          it('should be instrumented with flags', (done) => {
            expectOneSpan(agent, done, {
              resource: 'promises.open',
              meta: {
                'file.flag': 'r+',
                'file.path': __filename
              }
            })

            fs.promises.open(__filename, 'r+').then(_fd => {
              fd = _fd
            }, done)
          })

          it('should handle errors', (done) => {
            const filename = path.join(__filename, Math.random().toString())
            fs.promises.open(filename, 'r').catch((err) => {
              expectOneSpan(agent, done, {
                resource: 'promises.open',
                error: 0,
                meta: {
                  'file.flag': 'r',
                  'file.path': filename
                }
              })
            })
          })
        })
      }

      describe('openSync', () => {
        let fd
        afterEach(() => {
          if (typeof fd === 'number') {
            realFS.closeSync(fd)
            fd = undefined
          }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource: 'openSync',
            meta: {
              'file.flag': 'r',
              'file.path': __filename
            }
          })

          fd = fs.openSync(__filename)
        })

        it('should be instrumented with flags', (done) => {
          expectOneSpan(agent, done, {
            resource: 'openSync',
            meta: {
              'file.flag': 'r+',
              'file.path': __filename
            }
          })

          fd = fs.openSync(__filename, 'r+')
        })

        it('should handle errors', (done) => {
          const filename = path.join(__filename, Math.random().toString())
          try {
            fs.openSync(filename, 'r')
          } catch (err) {
            expectOneSpan(agent, done, {
              resource: 'openSync',
              error: 0,
              meta: {
                'file.flag': 'r',
                'file.path': filename
              }
            })
          }
        })
      })

      describeThreeWays('close', (resource, tested) => {
        it('should be instrumented', (done) => {
          const fd = realFS.openSync(__filename, 'r')
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.descriptor': fd.toString()
            }
          })

          tested(fs, [fd], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [8675309], agent))
      })

      describeThreeWays('readFile', (resource, tested) => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.flag': 'r',
              'file.path': __filename
            }
          })

          tested(fs, [__filename], done)
        })

        it('should be instrumented with flags', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.flag': 'r+',
              'file.path': __filename
            }
          })

          tested(fs, [__filename, { flag: 'r+' }], done)
        })

        it('should not fail if options is a string', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.flag': 'r',
              'file.path': __filename
            }
          })

          tested(fs, [__filename, 'utf8'], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename', { flag: 'r' }], agent))
      })

      describeThreeWays('writeFile', (resource, tested) => {
        let filename
        beforeEach(() => {
          filename = path.join(tmpdir, 'writeFile')
        })
        afterEach(() => {
          try {
            realFS.unlinkSync(filename)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.flag': 'w',
              'file.path': filename
            }
          })

          tested(fs, [filename, 'test'], done)
        })

        it('should be instrumented with flags', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.flag': 'w+',
              'file.path': filename
            }
          })

          tested(fs, [filename, 'test', { flag: 'w+' }], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [filename, 'test', { flag: 'r' }], agent))
      })

      describeThreeWays('appendFile', (resource, tested) => {
        let filename
        beforeEach(() => {
          filename = path.join(tmpdir, 'appendFile')
        })
        afterEach(() => {
          try {
            realFS.unlinkSync(filename)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.flag': 'a',
              'file.path': filename
            }
          })

          tested(fs, [filename, 'test'], done)
        })

        it('should be instrumented with flags', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.flag': 'a+',
              'file.path': filename
            }
          })

          tested(fs, [filename, 'test', { flag: 'a+' }], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [filename, 'test', { flag: 'r' }], agent))
      })

      describeThreeWays('access', (resource, tested) => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': __filename
            }
          })

          tested(fs, [__filename], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename'], agent))
      })

      describeThreeWays('copyFile', (resource, tested) => {
        const dest = `${__filename}copy`
        afterEach(() => {
          try {
            realFS.unlinkSync(dest)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.src': __filename,
              'file.dest': dest
            }
          })

          tested(fs, [__filename, dest], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [__filename, __filename, fs.constants.COPYFILE_EXCL], agent))
      })

      describeThreeWays('stat', (resource, tested) => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': __filename
            }
          })

          tested(fs, [__filename], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename'], agent))
      })

      describeThreeWays('lstat', (resource, tested) => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': __filename
            }
          })

          tested(fs, [__filename], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename'], agent))
      })

      describeThreeWays('fstat', (resource, tested) => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.descriptor': '1'
            }
          })

          tested(fs, [1], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [8675309], agent))
      })

      describeThreeWays('readdir', (resource, tested) => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': __dirname
            }
          })

          tested(fs, [__dirname], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/baddirname'], agent))
      })

      describeThreeWays('opendir', (resource, tested) => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': __dirname
            }
          })

          tested(fs, [__dirname], (err, dir) => {
            if (err) done(err)
            else dir.close(done)
          })
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/baddirname'], agent))
      })

      describeThreeWays('read', (resource, tested) => {
        let fd
        beforeEach(() => {
          fd = realFS.openSync(__filename, 'r')
        })
        afterEach(() => {
          realFS.closeSync(fd)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.descriptor': fd.toString()
            }
          })
          tested(fs, [fd, Buffer.alloc(5), 0, 5, 0], done)
        })

        if (resource === 'read') {
          it('should support promisification', () => {
            const read = util.promisify(fs.read)

            return read(fd, Buffer.alloc(5), 0, 5, 0)
          })
        }

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [8675309, Buffer.alloc(5), 0, 5, 0], agent))
      })

      describeThreeWays('write', (resource, tested) => {
        let fd
        let filename
        beforeEach(() => {
          filename = path.join(tmpdir, 'write')
          fd = realFS.openSync(filename, 'w')
        })
        afterEach(() => {
          realFS.closeSync(fd)
          realFS.unlinkSync(filename)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.descriptor': fd.toString()
            }
          })
          tested(fs, [fd, Buffer.from('hello'), 0, 5, 0], done)
        })

        if (resource === 'write') {
          it('should support promisification', () => {
            const write = util.promisify(fs.write)

            return write(fd, Buffer.from('hello'), 0, 5, 0)
          })
        }

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [8675309, Buffer.alloc(5), 0, 5, 0], agent))
      })

      if (hasWritev) {
        describeThreeWays('writev', (resource, tested) => {
          let fd
          let filename
          beforeEach(() => {
            filename = path.join(tmpdir, 'writev')
            fd = realFS.openSync(filename, 'w')
          })
          afterEach(() => {
            realFS.closeSync(fd)
            realFS.unlinkSync(filename)
          })

          it('should be instrumented', (done) => {
            expectOneSpan(agent, done, {
              resource,
              meta: {
                'file.descriptor': fd.toString()
              }
            })
            tested(fs, [fd, [Buffer.from('hello')], 0], done)
          })

          if (resource === 'writev') {
            it('should support promisification', () => {
              const writev = util.promisify(fs.writev)

              return writev(fd, [Buffer.from('hello')], 0)
            })
          }

          it('should handle errors', () =>
            testHandleErrors(fs, resource, tested, [8675309, [Buffer.alloc(5)], 0], agent))
        })
      }

      describe('createReadStream', () => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource: 'ReadStream',
            meta: {
              'file.path': __filename,
              'file.flag': 'r'
            }
          })
          fs.createReadStream(__filename).on('error', done).resume()
        })

        it('should be instrumented when closed', (done) => {
          expectOneSpan(agent, done, {
            resource: 'ReadStream',
            meta: {
              'file.path': __filename,
              'file.flag': 'r+'
            }
          })
          fs.createReadStream(__filename, { flags: 'r+' }).on('error', done).destroy()
        })

        it('should be instrumented with flags', (done) => {
          expectOneSpan(agent, done, {
            resource: 'ReadStream',
            meta: {
              'file.path': __filename,
              'file.flag': 'r+'
            }
          })
          fs.createReadStream(__filename, { flags: 'r+' }).on('error', done).resume()
        })

        it('should handle errors', () => {
          testHandleErrors(fs, 'ReadStream', (fs, args, _, cb) => {
            fs.createReadStream(...args).on('error', cb).emit('error', new Error('bad'))
          }, [__filename], agent)
        })
      })

      describe('createWriteStream', () => {
        let filename
        beforeEach(() => {
          filename = path.join(tmpdir, 'createWriteStream')
        })
        afterEach(done => {
          // swallow errors since we're causing a race condition in one of the tests
          realFS.unlink(filename, () => done())
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource: 'WriteStream',
            meta: {
              'file.path': filename,
              'file.flag': 'w'
            }
          })

          fs.createWriteStream(filename).on('error', done).end()
        })

        it('should be instrumented when closed', (done) => {
          expectOneSpan(agent, done, {
            resource: 'WriteStream',
            meta: {
              'file.path': filename,
              'file.flag': 'w'
            }
          })

          fs.createWriteStream(filename).on('error', done).destroy()
        })

        it('should be instrumented with flags', (done) => {
          expectOneSpan(agent, done, {
            resource: 'WriteStream',
            meta: {
              'file.path': filename,
              'file.flag': 'w+'
            }
          })

          fs.createWriteStream(filename, { flags: 'w+' }).on('error', done).end()
        })

        it('should handle errors', () => {
          testHandleErrors(fs, 'WriteStream', (fs, args, _, cb) => {
            fs.createWriteStream(...args).on('error', cb).emit('error', new Error('bad'))
          }, [filename], agent)
        })
      })

      describeThreeWays('chmod', (resource, tested) => {
        let mode
        beforeEach(() => {
          mode = realFS.statSync(__filename).mode % 0o100000
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': __filename,
              'file.mode': mode.toString(8)
            }
          })

          tested(fs, [__filename, mode], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename', mode], agent))
      })

      if (hasOSymlink) {
        describeThreeWays('lchmod', (resource, tested) => {
          let mode
          beforeEach(() => {
            mode = realFS.statSync(__filename).mode % 0o100000
          })

          it('should be instrumented', (done) => {
            expectOneSpan(agent, done, {
              resource,
              meta: {
                'file.path': __filename,
                'file.mode': mode.toString(8)
              }
            })

            tested(fs, [__filename, mode], done)
          })

          it('should handle errors', () =>
            testHandleErrors(fs, resource, tested, ['/badfilename', mode], agent))
        })
      }

      describeThreeWays('fchmod', (resource, tested) => {
        let mode
        let fd
        beforeEach(() => {
          mode = realFS.statSync(__filename).mode % 0o100000
          fd = realFS.openSync(__filename, 'r')
        })
        afterEach(() => {
          realFS.closeSync(fd)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource: resource,
            meta: {
              'file.descriptor': fd.toString(),
              'file.mode': mode.toString(8)
            }
          })

          tested(fs, [fd, mode], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [8675309, mode], agent))
      })

      describeThreeWays('chown', (resource, tested) => {
        let uid
        let gid
        beforeEach(() => {
          const stats = realFS.statSync(__filename)
          uid = stats.uid
          gid = stats.gid
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': __filename,
              'file.uid': uid.toString(),
              'file.gid': gid.toString()
            }
          })

          tested(fs, [__filename, uid, gid], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename', uid, gid], agent))
      })

      if (hasOSymlink) {
        describeThreeWays('lchown', (resource, tested) => {
          let uid
          let gid
          beforeEach(() => {
            const stats = realFS.statSync(__filename)
            uid = stats.uid
            gid = stats.gid
          })

          it('should be instrumented', (done) => {
            expectOneSpan(agent, done, {
              resource,
              meta: {
                'file.path': __filename,
                'file.uid': uid.toString(),
                'file.gid': gid.toString()
              }
            })

            tested(fs, [__filename, uid, gid], done)
          })

          it('should handle errors', () =>
            testHandleErrors(fs, resource, tested, ['/badfilename', uid, gid], agent))
        })
      }

      describeThreeWays('fchown', (resource, tested) => {
        let uid
        let gid
        let fd
        beforeEach(() => {
          const stats = realFS.statSync(__filename)
          uid = stats.uid
          gid = stats.gid
          fd = realFS.openSync(__filename, 'r')
        })
        afterEach(() => {
          realFS.closeSync(fd)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.descriptor': fd.toString(),
              'file.uid': uid.toString(),
              'file.gid': gid.toString()
            }
          })

          tested(fs, [fd, uid, gid], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [8675309, uid, gid], agent))
      })

      describeThreeWays('realpath', (resource, tested) => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': __filename
            }
          })
          tested(fs, [__filename], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename'], agent))
      })

      if (realFS.realpath.native) {
        describeThreeWays('realpath.native', (resource, tested) => {
          it('should be instrumented', (done) => {
            expectOneSpan(agent, done, {
              resource,
              meta: {
                'file.path': __filename
              }
            })
            tested(fs, [__filename], done)
          })

          it('should handle errors', () =>
            testHandleErrors(fs, resource, tested, ['/badfilename'], agent))
        })
      }

      describeThreeWays('readlink', (resource, tested) => {
        let link
        beforeEach(() => {
          link = path.join(tmpdir, 'link')
          realFS.symlinkSync(__filename, link)
        })
        afterEach(() => {
          realFS.unlinkSync(link)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': link
            }
          })
          tested(fs, [link], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename'], agent))
      })

      describeThreeWays('unlink', (resource, tested) => {
        let link
        beforeEach(() => {
          link = path.join(tmpdir, 'link')
          realFS.symlinkSync(__filename, link)
        })
        afterEach(() => {
          try {
            realFS.unlinkSync(link)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': link
            }
          })
          tested(fs, [link], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename'], agent))
      })

      describeThreeWays('symlink', (resource, tested) => {
        let link
        beforeEach(() => {
          link = path.join(tmpdir, 'link')
        })
        afterEach(() => {
          try {
            realFS.unlinkSync(link)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.src': __filename,
              'file.dest': link
            }
          })
          tested(fs, [__filename, link], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [__filename, '/baddir/badfilename'], agent))
      })

      describeThreeWays('link', (resource, tested) => {
        let link
        let sourceFile
        beforeEach(() => {
          sourceFile = path.join(tmpdir, 'source')
          realFS.writeFileSync(sourceFile, '')
          link = path.join(tmpdir, 'link')
        })
        afterEach(() => {
          try {
            realFS.unlinkSync(sourceFile)
          } catch (e) { /* */ }
          try {
            realFS.unlinkSync(link)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.src': sourceFile,
              'file.dest': link
            }
          })
          tested(fs, [sourceFile, link], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename', link], agent))
      })

      describeThreeWays('rmdir', (resource, tested) => {
        let dir
        beforeEach(() => {
          dir = path.join(tmpdir, 'dir')
          realFS.mkdirSync(dir)
        })
        afterEach(() => {
          try {
            realFS.rmdirSync(dir)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': dir
            }
          })
          tested(fs, [dir], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename'], agent))
      })

      describeThreeWays('rename', (resource, tested) => {
        let src
        let dest
        beforeEach(() => {
          src = path.join(tmpdir, 'src')
          dest = path.join(tmpdir, 'dest')
          realFS.writeFileSync(src, '')
        })
        afterEach(() => {
          try {
            realFS.unlinkSync(dest)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.src': src,
              'file.dest': dest
            }
          })
          tested(fs, [src, dest], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename', dest], agent))
      })

      describeThreeWays('fsync', (resource, tested) => {
        let fd
        let tmpfile
        beforeEach(() => {
          tmpfile = path.join(tmpdir, 'fsync')
          fd = realFS.openSync(tmpfile, 'w')
        })
        afterEach(() => {
          realFS.closeSync(fd)
          realFS.unlinkSync(tmpfile)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.descriptor': fd.toString()
            }
          })
          tested(fs, [fd], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [8675309], agent))
      })

      describeThreeWays('fdatasync', (resource, tested) => {
        let fd
        let tmpfile
        beforeEach(() => {
          tmpfile = path.join(tmpdir, 'fdatasync')
          fd = realFS.openSync(tmpfile, 'w')
        })
        afterEach(() => {
          realFS.closeSync(fd)
          realFS.unlinkSync(tmpfile)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.descriptor': fd.toString()
            }
          })
          tested(fs, [fd], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [8675309], agent))
      })

      describeThreeWays('mkdir', (resource, tested) => {
        let dir
        beforeEach(() => {
          dir = path.join(tmpdir, 'mkdir')
        })
        afterEach(() => {
          try {
            realFS.rmdirSync(dir)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': dir
            }
          })
          tested(fs, [dir], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/baddir/baddir'], agent))
      })

      describeThreeWays('truncate', (resource, tested) => {
        let filename
        beforeEach(() => {
          filename = path.join(tmpdir, 'truncate')
          realFS.writeFileSync(filename, Buffer.alloc(10))
        })
        afterEach(() => {
          realFS.unlinkSync(filename)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': filename
            }
          })
          tested(fs, [filename, 5], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename', 5], agent))
      })

      describeThreeWays('ftruncate', (resource, tested) => {
        let filename
        let fd
        beforeEach(() => {
          filename = path.join(tmpdir, 'truncate')
          realFS.writeFileSync(filename, Buffer.alloc(10))
          fd = realFS.openSync(filename, 'w+')
        })
        afterEach(() => {
          realFS.closeSync(fd)
          realFS.unlinkSync(filename)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.descriptor': fd.toString()
            }
          })
          tested(fs, [fd, 5], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [8675309, 5], agent))
      })

      describeThreeWays('utimes', (resource, tested) => {
        let filename
        beforeEach(() => {
          filename = path.join(tmpdir, 'truncate')
          realFS.writeFileSync(filename, '')
        })
        afterEach(() => {
          realFS.unlinkSync(filename)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.path': filename
            }
          })
          tested(fs, [filename, Date.now(), Date.now()], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, ['/badfilename', Date.now(), Date.now()], agent))
      })

      describeThreeWays('futimes', (resource, tested) => {
        let filename
        let fd
        beforeEach(() => {
          filename = path.join(tmpdir, 'truncate')
          realFS.writeFileSync(filename, '')
          fd = realFS.openSync(filename, 'w')
        })
        afterEach(() => {
          realFS.closeSync(fd)
          realFS.unlinkSync(filename)
        })

        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource,
            meta: {
              'file.descriptor': fd.toString()
            }
          })
          tested(fs, [fd, Date.now(), Date.now()], done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, resource, tested, [8675309, Date.now(), Date.now()], agent))
      })

      describe('mkdtemp', () => {
        let tmpdir
        afterEach(() => {
          try {
            realFS.rmdirSync(tmpdir)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          const inputDir = path.join(os.tmpdir(), 'mkdtemp-')
          expectOneSpan(agent, done, {
            resource: 'mkdtemp',
            meta: {
              'file.path': inputDir
            }
          })
          fs.mkdtemp(inputDir, (err, result) => {
            if (err) {
              done(err)
              return
            }
            tmpdir = result
          })
        })

        it('should handle errors', () =>
          testHandleErrors(fs, 'mkdtemp', (fs, args, _, cb) => {
            fs.mkdtemp(...args, cb)
          }, ['/baddir/baddir'], agent))
      })

      describe('mkdtempSync', () => {
        let tmpdir
        afterEach(() => {
          try {
            realFS.rmdirSync(tmpdir)
          } catch (e) { /* */ }
        })

        it('should be instrumented', (done) => {
          const inputDir = path.join(os.tmpdir(), 'mkdtemp-')
          expectOneSpan(agent, done, {
            resource: 'mkdtempSync',
            meta: {
              'file.path': inputDir
            }
          })
          tmpdir = fs.mkdtempSync(inputDir)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, 'mkdtempSync', (fs, args, _, cb) => {
            try {
              fs.mkdtempSync(...args)
            } catch (e) {
              cb(e)
            }
          }, ['/baddir/baddir'], agent))
      })

      describe('exists', () => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource: 'exists',
            meta: {
              'file.path': __filename
            }
          })
          fs.exists(__filename, () => {}) // eslint-disable-line node/no-deprecated-api
        })

        it('should support promisification', () => {
          const exists = util.promisify(fs.exists) // eslint-disable-line node/no-deprecated-api

          return exists(__filename)
        })
      })

      describe('existsSync', () => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            resource: 'existsSync',
            meta: {
              'file.path': __filename
            }
          })
          fs.existsSync(__filename)
        })
      })

      if (realFS.Dir) {
        describe('Dir', () => {
          let dirname
          let dir
          beforeEach(async () => {
            dirname = path.join(tmpdir, 'dir')
            fs.mkdirSync(dirname)
            fs.writeFileSync(path.join(dirname, '1'), '1')
            fs.writeFileSync(path.join(dirname, '2'), '2')
            fs.writeFileSync(path.join(dirname, '3'), '3')
            dir = await fs.promises.opendir(dirname)
          })
          afterEach(async () => {
            try {
              await dir.close()
            } catch (e) {
              if (e.code !== 'ERR_DIR_CLOSED') {
                throw e
              }
            }
            fs.unlinkSync(path.join(dirname, '1'))
            fs.unlinkSync(path.join(dirname, '2'))
            fs.unlinkSync(path.join(dirname, '3'))
            fs.rmdirSync(dirname)
          })

          describe('close', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'dir.close',
                meta: {
                  'file.path': dirname
                }
              })
              dir.close().catch(done)
            })

            it('should handle errors', () =>
              testHandleErrors(fs, 'dir.close', async (_1, _2, _3, cb) => {
                dir.closeSync()
                try {
                  // await for Node >=15.4 that returns and rejects a promise instead of throwing
                  await dir.close()
                } catch (e) {
                  cb(e)
                }
              }, [], agent))

            it('should be instrumented with callback', (done) => {
              expectOneSpan(agent, done, {
                resource: 'dir.close',
                meta: {
                  'file.path': dirname
                }
              })
              dir.close(err => err && done(err))
            })

            it('should handle errors with callback', () =>
              testHandleErrors(fs, 'dir.close', (_1, _2, _3, cb) => {
                dir.closeSync()
                try {
                  dir.close(cb)
                } catch (e) {
                  cb(e)
                }
              }, [], agent))

            it('Sync should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'dir.closeSync',
                meta: {
                  'file.path': dirname
                }
              })
              dir.closeSync()
            })

            it('Sync should handle errors', () =>
              testHandleErrors(fs, 'dir.closeSync', (_1, _2, _3, cb) => {
                dir.closeSync()
                try {
                  dir.closeSync()
                } catch (e) {
                  cb(e)
                }
              }, [], agent))
          })

          describe('read', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'dir.read',
                meta: {
                  'file.path': dirname
                }
              })
              dir.read().catch(done)
            })

            it('should handle errors', () =>
              testHandleErrors(fs, 'dir.read', (_1, _2, _3, cb) => {
                dir.closeSync()
                try {
                  dir.read()
                } catch (e) {
                  cb(e)
                }
              }, [], agent))

            it('should be instrumented with callback', (done) => {
              expectOneSpan(agent, done, {
                resource: 'dir.read',
                meta: {
                  'file.path': dirname
                }
              })
              dir.read(err => err && done(err))
            })

            it('should handle errors with callback', () =>
              testHandleErrors(fs, 'dir.read', (_1, _2, _3, cb) => {
                dir.closeSync()
                try {
                  dir.read(cb)
                } catch (e) {
                  cb(e)
                }
              }, [], agent))

            it('Sync should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'dir.readSync',
                meta: {
                  'file.path': dirname
                }
              })
              dir.readSync()
            })

            it('Sync should handle errors', () =>
              testHandleErrors(fs, 'dir.readSync', (_1, _2, _3, cb) => {
                dir.closeSync()
                try {
                  dir.readSync()
                } catch (e) {
                  cb(e)
                }
              }, [], agent))
          })

          describe('Symbol.asyncIterator', () => {
            it('should be instrumented for reads', (done) => {
              expectOneSpan(agent, done, {
                resource: 'dir.read',
                meta: {
                  'file.path': dirname
                }
              })
              ;(async () => {
                const iterator = dir[Symbol.asyncIterator]()
                while (!(await iterator.next()).done) { /* noop */ }
              })().catch(done)
            })

            it('should be instrumented for close', (done) => {
              expectOneSpan(agent, done, {
                resource: 'dir.close',
                meta: {
                  'file.path': dirname
                }
              })
              ;(async () => {
                const iterator = dir[Symbol.asyncIterator]()
                while (!(await iterator.next()).done) { /* noop */ }
              })().catch(done)
            })
          })
        })
      }

      if (realFS.promises) {
        describe('FileHandle', () => {
          let filehandle
          let filename
          beforeEach(async () => {
            filename = path.join(os.tmpdir(), 'filehandle')
            fs.writeFileSync(filename, 'some data')
            filehandle = await fs.promises.open(filename, 'w+')
          })
          afterEach(async () => {
            try {
              await filehandle.close()
              realFS.closeSync(filehandle.fd)
            } catch (e) { /* */ }
            await fs.promises.unlink(filename)
          })

          describe('appendFile', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.appendFile',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.appendFile('some more data').catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testFileHandleErrors(fs, 'appendFile', ['some more data'], filehandle, agent))
          })

          describe('writeFile', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.writeFile',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.writeFile('some more data').catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testFileHandleErrors(fs, 'writeFile', ['some more data'], filehandle, agent))
          })

          describe('readFile', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.readFile',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.readFile().catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testFileHandleErrors(fs, 'readFile', [], filehandle, agent))
          })

          describe('write', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.write',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.write('some more data').catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testFileHandleErrors(fs, 'write', ['some more data'], filehandle, agent))
          })

          if (hasWritev) {
            describe('writev', () => {
              it('should be instrumented', (done) => {
                expectOneSpan(agent, done, {
                  resource: 'filehandle.writev',
                  meta: {
                    'file.descriptor': filehandle.fd.toString()
                  }
                })
                filehandle.writev([Buffer.from('some more data')]).catch(done)
              })

              // https://github.com/nodejs/node/issues/31361
              it.skip('should handle errors', () =>
                testFileHandleErrors(fs, 'writev', [[Buffer.from('some more data')]], filehandle, agent))
            })
          }

          describe('read', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.read',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.read(Buffer.alloc(5), 0, 5, 0).catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testFileHandleErrors(fs, 'read', [Buffer.alloc(5), 0, 5, 0], filehandle, agent))
          })

          describe('chmod', () => {
            let mode
            beforeEach(() => {
              mode = realFS.statSync(__filename).mode % 0o100000
            })

            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.chmod',
                meta: {
                  'file.descriptor': filehandle.fd.toString(),
                  'file.mode': mode.toString(8)
                }
              })
              filehandle.chmod(mode).catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testFileHandleErrors(fs, 'chmod', [mode], filehandle, agent))
          })

          describe('chown', () => {
            let uid
            let gid
            beforeEach(() => {
              const stats = realFS.statSync(filename)
              uid = stats.uid
              gid = stats.gid
            })

            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.chown',
                meta: {
                  'file.descriptor': filehandle.fd.toString(),
                  'file.uid': uid.toString(),
                  'file.gid': gid.toString()
                }
              })
              filehandle.chown(uid, gid).catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testFileHandleErrors(fs, 'chown', [uid, gid], filehandle, agent))
          })

          describe('stat', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.stat',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.stat().catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testHandleErrors(fs, 'stat', [], filehandle, agent))
          })

          describe('sync', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.sync',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.sync().catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testHandleErrors(fs, 'sync', [], filehandle, agent))
          })

          describe('datasync', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.datasync',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.datasync().catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testHandleErrors(fs, 'datasync', [], filehandle, agent))
          })

          describe('truncate', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.truncate',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.truncate(5).catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testHandleErrors(fs, 'truncate', [5], filehandle, agent))
          })

          describe('utimes', () => {
            it('should be instrumented', (done) => {
              expectOneSpan(agent, done, {
                resource: 'filehandle.utimes',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.utimes(Date.now(), Date.now()).catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testHandleErrors(fs, 'utimes', [Date.now(), Date.now()], filehandle, agent))
          })

          describe('close', () => {
            it('should be instrumented', function (done) {
              expectOneSpan(agent, done, {
                resource: 'filehandle.close',
                meta: {
                  'file.descriptor': filehandle.fd.toString()
                }
              })
              filehandle.close().catch(done)
            })

            // https://github.com/nodejs/node/issues/31361
            it.skip('should handle errors', () =>
              testFileHandleErrors(fs, 'close', [], filehandle, agent))
          })
        })
      }

      function describeThreeWays (name, fn) {
        const reducer = (acc, cur) => acc[cur]
        if (name.split('.').reduce(reducer, realFS)) {
          describe(name, () => {
            fn(name, (fs, args, done, withError) => {
              const span = {}
              return tracer.scope().activate(span, () => {
                args.push((err) => {
                  expect(tracer.scope().active()).to.equal(span)
                  if (err) {
                    if (withError) withError(err)
                    else done(err)
                  }
                })
                const func = name.split('.').reduce((acc, cur) => acc[cur], fs)
                return func.apply(fs, args)
              })
            })
          })
        }

        if (realFS.promises && name in realFS.promises) {
          describe('promises.' + name, () => {
            fn('promises.' + name, (fs, args, done, withError) => {
              const span = {}
              return tracer.scope().activate(span, () => {
                return fs.promises[name].apply(fs.promises, args)
                  .then(() => {
                    expect(tracer.scope().active()).to.equal(span)
                  })
                  .catch((err) => {
                    if (withError) withError(err)
                    else done(err)
                  })
              })
            })
          })
        }

        const nameSync = name + 'Sync'

        if (nameSync in realFS) {
          describe(nameSync, () => {
            fn(nameSync, (fs, args, _, withError) => {
              try {
                return fs[nameSync].apply(fs, args)
              } catch (err) {
                if (withError) withError(err)
                else throw err
              }
            })
          })
        }
      }
    })
  })
})

function mkExpected (props) {
  const meta = Object.assign({ component: 'fs', 'span.kind': 'internal' }, props.meta)
  const expected = Object.assign({
    name: 'fs.operation',
    error: 0,
    service: 'test'
  }, props)
  expected.meta = meta
  return expected
}

function expectOneSpan (agent, done, expected, timeout) {
  expected = mkExpected(expected)
  expectSomeSpan(agent, expected, timeout).then(done, done)
}

function testHandleErrors (fs, name, tested, args, agent) {
  return new Promise((resolve, reject) => {
    function done (err) {
      if (err) reject(err)
      else resolve()
    }
    tested(fs, args, null, err => {
      expectOneSpan(agent, done, {
        resource: name,
        error: 0
      })
    })
  })
}

function testFileHandleErrors (fs, method, args, filehandle, agent) {
  const name = 'filehandle.' + method
  return testHandleErrors(fs, name, (fs, args, _, cb) => {
    filehandle.close()
      .then(() => filehandle[method](...args))
      .catch(cb)
  }, args, agent)
}
