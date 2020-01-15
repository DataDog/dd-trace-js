'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

const realFS = Object.assign({}, require('fs'))
const os = require('os')
const path = require('path')
const semver = require('semver')
const rimraf = require('rimraf')

const implicitFlag = semver.satisfies(process.versions.node, '>=11.1.0')
const hasWritev = semver.satisfies(process.versions.node, '>=12.9.0')
const hasOSymlink = realFS.constants.O_SYMLINK

wrapIt()

// TODO remove skips

describe('fs', () => {
  let fs
  let tmpdir
  let tracer
  afterEach(() => agent.close())
  beforeEach(() => agent.load(plugin, 'fs').then(() => {
    tracer = require('../../dd-trace')
    fs = require('fs')
  }))
  before(() => {
    tmpdir = realFS.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-js-test'))
  })
  after((done) => {
    rimraf(tmpdir, realFS, done)
  })

  describe('open', () => {
    let fd
    afterEach(() => {
      if (typeof fd === 'number') {
        realFS.closeSync(fd)
        fd = undefined
      }
    })

    if (implicitFlag) {
      it('should be instrumented', (done) => {
        expectOneSpan(agent, done, {
          name: 'fs.open',
          resource: __filename,
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
    }

    it('should be instrumented with flags', (done) => {
      expectOneSpan(agent, done, {
        name: 'fs.open',
        resource: __filename,
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
          name: 'fs.open',
          resource: filename,
          error: 1,
          meta: {
            'file.flag': 'r',
            'file.path': filename,
            'error.msg': err.message,
            'error.type': err.name,
            'error.stack': err.stack
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

      if (implicitFlag) {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            name: 'fs.promises.open',
            resource: __filename,
            meta: {
              'file.flag': 'r',
              'file.path': __filename
            }
          })

          fs.promises.open(__filename).then(_fd => {
            fd = _fd
          }, done)
        })
      }

      it('should be instrumented with flags', (done) => {
        expectOneSpan(agent, done, {
          name: 'fs.promises.open',
          resource: __filename,
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
            name: 'fs.promises.open',
            resource: filename,
            error: 1,
            meta: {
              'file.flag': 'r',
              'file.path': filename,
              'error.msg': err.message,
              'error.type': err.name,
              'error.stack': err.stack
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

    if (implicitFlag) {
      it('should be instrumented', (done) => {
        expectOneSpan(agent, done, {
          name: 'fs.opensync',
          resource: __filename,
          meta: {
            'file.flag': 'r',
            'file.path': __filename
          }
        })

        fd = fs.openSync(__filename)
      })
    }

    it('should be instrumented with flags', (done) => {
      expectOneSpan(agent, done, {
        name: 'fs.opensync',
        resource: __filename,
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
          name: 'fs.opensync',
          resource: filename,
          error: 1,
          meta: {
            'file.flag': 'r',
            'file.path': filename,
            'error.msg': err.message,
            'error.type': err.name,
            'error.stack': err.stack
          }
        })
      }
    })
  })

  describeThreeWays('close', (name, tested) => {
    it('should be instrumented', (done) => {
      const fd = realFS.openSync(__filename, 'r')
      expectOneSpan(agent, done, {
        name,
        resource: fd.toString(),
        meta: {
          'file.descriptor': fd.toString()
        }
      })

      tested(fs, [fd], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [8675309], agent))
  })

  describeThreeWays('readFile', (name, tested) => {
    if (implicitFlag) {
      it('should be instrumented', (done) => {
        expectOneSpan(agent, done, {
          name,
          resource: __filename,
          meta: {
            'file.flag': 'r',
            'file.path': __filename
          }
        })

        tested(fs, [__filename], done)
      })
    }

    it('should be instrumented with flags', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: __filename,
        meta: {
          'file.flag': 'r+',
          'file.path': __filename
        }
      })

      tested(fs, [__filename, { flag: 'r+' }], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename', { flag: 'r' }], agent))
  })

  describeThreeWays('writeFile', (name, tested) => {
    let filename
    beforeEach(() => {
      filename = path.join(tmpdir, 'writeFile')
    })
    afterEach(() => {
      try {
        realFS.unlinkSync(filename)
      } catch (e) { /* */ }
    })

    if (implicitFlag) {
      it('should be instrumented', (done) => {
        expectOneSpan(agent, done, {
          name,
          resource: filename,
          meta: {
            'file.flag': 'w',
            'file.path': filename
          }
        })

        tested(fs, [filename, 'test'], done)
      })
    }

    it('should be instrumented with flags', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: filename,
        meta: {
          'file.flag': 'w+',
          'file.path': filename
        }
      })

      tested(fs, [filename, 'test', { flag: 'w+' }], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [filename, 'test', { flag: 'r' }], agent))
  })

  describeThreeWays('appendFile', (name, tested) => {
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
        name,
        resource: filename,
        meta: {
          'file.flag': 'a',
          'file.path': filename
        }
      })

      tested(fs, [filename, 'test'], done)
    })

    it('should be instrumented with flags', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: filename,
        meta: {
          'file.flag': 'a+',
          'file.path': filename
        }
      })

      tested(fs, [filename, 'test', { flag: 'a+' }], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [filename, 'test', { flag: 'r' }], agent))
  })

  describeThreeWays('access', (name, tested) => {
    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: __filename,
        meta: {
          'file.path': __filename
        }
      })

      tested(fs, [__filename], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename'], agent))
  })

  describeThreeWays('copyFile', (name, tested) => {
    const dest = `${__filename}copy`
    afterEach(() => {
      try {
        realFS.unlinkSync(dest)
      } catch (e) { /* */ }
    })

    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: __filename,
        meta: {
          'file.src': __filename,
          'file.dest': dest
        }
      })

      tested(fs, [__filename, dest], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [__filename, __filename, fs.constants.COPYFILE_EXCL], agent))
  })

  describeThreeWays('stat', (name, tested) => {
    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: __filename,
        meta: {
          'file.path': __filename
        }
      })

      tested(fs, [__filename], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename'], agent))
  })

  describeThreeWays('lstat', (name, tested) => {
    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: __filename,
        meta: {
          'file.path': __filename
        }
      })

      tested(fs, [__filename], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename'], agent))
  })

  describeThreeWays('fstat', (name, tested) => {
    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: '1',
        meta: {
          'file.descriptor': '1'
        }
      })

      tested(fs, [1], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [8675309], agent))
  })

  describeThreeWays('readdir', (name, tested) => {
    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: __dirname,
        meta: {
          'file.path': __dirname
        }
      })

      tested(fs, [__dirname], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/baddirname'], agent))
  })

  describeThreeWays('opendir', (name, tested) => {
    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: __dirname,
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
      testHandleErrors(fs, name, tested, ['/baddirname'], agent))
  })

  describeThreeWays('read', (name, tested) => {
    let fd
    beforeEach(() => {
      fd = realFS.openSync(__filename, 'r')
    })
    afterEach(() => {
      realFS.closeSync(fd)
    })

    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: fd.toString(),
        meta: {
          'file.descriptor': fd.toString()
        }
      })
      tested(fs, [fd, Buffer.alloc(5), 0, 5, 0], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [8675309, Buffer.alloc(5), 0, 5, 0], agent))
  })

  describeThreeWays('write', (name, tested) => {
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
        name,
        resource: fd.toString(),
        meta: {
          'file.descriptor': fd.toString()
        }
      })
      tested(fs, [fd, Buffer.from('hello'), 0, 5, 0], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [8675309, Buffer.alloc(5), 0, 5, 0], agent))
  })

  if (hasWritev) {
    describeThreeWays('writev', (name, tested) => {
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
          name,
          resource: fd.toString(),
          meta: {
            'file.descriptor': fd.toString()
          }
        })
        tested(fs, [fd, [Buffer.from('hello')], 0], done)
      })

      it('should handle errors', () =>
        testHandleErrors(fs, name, tested, [8675309, [Buffer.alloc(5)], 0], agent))
    })
  }

  describe('createReadStream', () => {
    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name: 'fs.readstream',
        resource: __filename,
        meta: {
          'file.path': __filename,
          'file.flag': 'r'
        }
      })
      fs.createReadStream(__filename).on('error', done).resume()
    })

    it('should be instrumented with flags', (done) => {
      expectOneSpan(agent, done, {
        name: 'fs.readstream',
        resource: __filename,
        meta: {
          'file.path': __filename,
          'file.flag': 'r+'
        }
      })
      fs.createReadStream(__filename, { flags: 'r+' }).on('error', done).resume()
    })

    it('should handle errors', () => {
      testHandleErrors(fs, 'fs.readstream', (fs, args, _, cb) => {
        fs.createReadStream(...args).on('error', cb).emit('error', new Error('bad'))
      }, [__filename], agent)
    })
  })

  describe('createWriteStream', () => {
    let filename
    beforeEach(() => {
      filename = path.join(tmpdir, 'createWriteStream')
    })
    afterEach(() => {
      realFS.unlinkSync(filename)
    })

    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name: 'fs.writestream',
        resource: filename,
        meta: {
          'file.path': filename,
          'file.flag': 'w'
        }
      })

      fs.createWriteStream(filename).on('error', done).end()
    })

    it('should be instrumented with flags', (done) => {
      expectOneSpan(agent, done, {
        name: 'fs.writestream',
        resource: filename,
        meta: {
          'file.path': filename,
          'file.flag': 'w+'
        }
      })

      fs.createWriteStream(filename, { flags: 'w+' }).on('error', done).end()
    })

    it('should handle errors', () => {
      testHandleErrors(fs, 'fs.writestream', (fs, args, _, cb) => {
        fs.createWriteStream(...args).on('error', cb).emit('error', new Error('bad'))
      }, [filename], agent)
    })
  })

  describeThreeWays('chmod', (name, tested) => {
    let mode
    beforeEach(() => {
      mode = realFS.statSync(__filename).mode % 0o100000
    })

    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: __filename,
        meta: {
          'file.path': __filename,
          'file.mode': mode.toString(8)
        }
      })

      tested(fs, [__filename, mode], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename', mode], agent))
  })

  if (hasOSymlink) {
    describeThreeWays('lchmod', (name, tested) => {
      let mode
      beforeEach(() => {
        mode = realFS.statSync(__filename).mode % 0o100000
      })

      it('should be instrumented', (done) => {
        expectOneSpan(agent, done, {
          name,
          resource: __filename,
          meta: {
            'file.path': __filename,
            'file.mode': mode.toString(8)
          }
        })

        tested(fs, [__filename, mode], done)
      })

      it('should handle errors', () =>
        testHandleErrors(fs, name, tested, ['/badfilename', mode], agent))
    })
  }

  describeThreeWays('fchmod', (name, tested) => {
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
        name,
        resource: fd.toString(),
        meta: {
          'file.descriptor': fd.toString(),
          'file.mode': mode.toString(8)
        }
      })

      tested(fs, [fd, mode], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [8675309, mode], agent))
  })

  describeThreeWays('chown', (name, tested) => {
    let uid
    let gid
    beforeEach(() => {
      const stats = realFS.statSync(__filename)
      uid = stats.uid
      gid = stats.gid
    })

    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: __filename,
        meta: {
          'file.path': __filename,
          'file.uid': uid.toString(),
          'file.gid': gid.toString()
        }
      })

      tested(fs, [__filename, uid, gid], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename', uid, gid], agent))
  })

  if (hasOSymlink) {
    describeThreeWays('lchown', (name, tested) => {
      let uid
      let gid
      beforeEach(() => {
        const stats = realFS.statSync(__filename)
        uid = stats.uid
        gid = stats.gid
      })

      it('should be instrumented', (done) => {
        expectOneSpan(agent, done, {
          name,
          resource: __filename,
          meta: {
            'file.path': __filename,
            'file.uid': uid.toString(),
            'file.gid': gid.toString()
          }
        })

        tested(fs, [__filename, uid, gid], done)
      })

      it('should handle errors', () =>
        testHandleErrors(fs, name, tested, ['/badfilename', uid, gid], agent))
    })
  }

  describeThreeWays('fchown', (name, tested) => {
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
        name,
        resource: fd.toString(),
        meta: {
          'file.descriptor': fd.toString(),
          'file.uid': uid.toString(),
          'file.gid': gid.toString()
        }
      })

      tested(fs, [fd, uid, gid], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [8675309, uid, gid], agent))
  })

  describeThreeWays('realpath', (name, tested) => {
    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name,
        resource: __filename,
        meta: {
          'file.path': __filename
        }
      })
      tested(fs, [__filename], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename'], agent))
  })

  describeThreeWays('readlink', (name, tested) => {
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
        name,
        resource: link,
        meta: {
          'file.path': link
        }
      })
      tested(fs, [link], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename'], agent))
  })

  describeThreeWays('unlink', (name, tested) => {
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
        name,
        resource: link,
        meta: {
          'file.path': link
        }
      })
      tested(fs, [link], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename'], agent))
  })

  describeThreeWays('symlink', (name, tested) => {
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
        name,
        resource: __filename,
        meta: {
          'file.src': __filename,
          'file.dest': link
        }
      })
      tested(fs, [__filename, link], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [__filename, '/baddir/badfilename'], agent))
  })

  describeThreeWays('link', (name, tested) => {
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
        name,
        resource: __filename,
        meta: {
          'file.src': __filename,
          'file.dest': link
        }
      })
      tested(fs, [__filename, link], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename', link], agent))
  })

  describeThreeWays('rmdir', (name, tested) => {
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
        name,
        resource: dir,
        meta: {
          'file.path': dir
        }
      })
      tested(fs, [dir], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename'], agent))
  })

  describeThreeWays('rename', (name, tested) => {
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
        name,
        resource: src,
        meta: {
          'file.src': src,
          'file.dest': dest
        }
      })
      tested(fs, [src, dest], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename', dest], agent))
  })

  describeThreeWays('fsync', (name, tested) => {
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
        name,
        resource: fd.toString(),
        meta: {
          'file.descriptor': fd.toString()
        }
      })
      tested(fs, [fd], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [8675309], agent))
  })

  describeThreeWays('fdatasync', (name, tested) => {
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
        name,
        resource: fd.toString(),
        meta: {
          'file.descriptor': fd.toString()
        }
      })
      tested(fs, [fd], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [8675309], agent))
  })

  describeThreeWays('mkdir', (name, tested) => {
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
        name,
        resource: dir,
        meta: {
          'file.path': dir
        }
      })
      tested(fs, [dir], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/baddir/baddir'], agent))
  })

  describeThreeWays('truncate', (name, tested) => {
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
        name,
        resource: filename,
        meta: {
          'file.path': filename
        }
      })
      tested(fs, [filename, 5], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename', 5], agent))
  })

  describeThreeWays('ftruncate', (name, tested) => {
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
        name,
        resource: fd.toString(),
        meta: {
          'file.descriptor': fd.toString()
        }
      })
      tested(fs, [fd, 5], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [8675309, 5], agent))
  })

  describeThreeWays('utimes', (name, tested) => {
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
        name,
        resource: filename,
        meta: {
          'file.path': filename
        }
      })
      tested(fs, [filename, Date.now(), Date.now()], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, ['/badfilename', Date.now(), Date.now()], agent))
  })

  describeThreeWays('futimes', (name, tested) => {
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
        name,
        resource: fd.toString(),
        meta: {
          'file.descriptor': fd.toString()
        }
      })
      tested(fs, [fd, Date.now(), Date.now()], done)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, name, tested, [8675309, Date.now(), Date.now()], agent))
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
        name: 'fs.mkdtemp',
        resource: inputDir,
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
      testHandleErrors(fs, 'fs.mkdtemp', (fs, args, _, cb) => {
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
        name: 'fs.mkdtempsync',
        resource: inputDir,
        meta: {
          'file.path': inputDir
        }
      })
      tmpdir = fs.mkdtempSync(inputDir)
    })

    it('should handle errors', () =>
      testHandleErrors(fs, 'fs.mkdtempsync', (fs, args, _, cb) => {
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
        name: 'fs.exists',
        resource: __filename,
        meta: {
          'file.path': __filename
        }
      })
      fs.exists(__filename, () => {}) // eslint-disable-line node/no-deprecated-api
    })
  })

  describe('existsSync', () => {
    it('should be instrumented', (done) => {
      expectOneSpan(agent, done, {
        name: 'fs.existssync',
        resource: __filename,
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
            name: 'fs.dir.close',
            resource: dirname,
            meta: {
              'file.path': dirname
            }
          })
          dir.close().catch(done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, 'fs.dir.close', (_1, _2, _3, cb) => {
            dir.closeSync()
            try {
              dir.close()
            } catch (e) {
              cb(e)
            }
          }, [], agent))

        it('should be instrumented with callback', (done) => {
          expectOneSpan(agent, done, {
            name: 'fs.dir.close',
            resource: dirname,
            meta: {
              'file.path': dirname
            }
          })
          dir.close(err => err && done(err))
        })

        it('should handle errors with callback', () =>
          testHandleErrors(fs, 'fs.dir.close', (_1, _2, _3, cb) => {
            dir.closeSync()
            try {
              dir.close(cb)
            } catch (e) {
              cb(e)
            }
          }, [], agent))

        it('Sync should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            name: 'fs.dir.closesync',
            resource: dirname,
            meta: {
              'file.path': dirname
            }
          })
          dir.closeSync()
        })

        it('Sync should handle errors', () =>
          testHandleErrors(fs, 'fs.dir.closesync', (_1, _2, _3, cb) => {
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
            name: 'fs.dir.read',
            resource: dirname,
            meta: {
              'file.path': dirname
            }
          })
          dir.read().catch(done)
        })

        it('should handle errors', () =>
          testHandleErrors(fs, 'fs.dir.read', (_1, _2, _3, cb) => {
            dir.closeSync()
            try {
              dir.read()
            } catch (e) {
              cb(e)
            }
          }, [], agent))

        it('should be instrumented with callback', (done) => {
          expectOneSpan(agent, done, {
            name: 'fs.dir.read',
            resource: dirname,
            meta: {
              'file.path': dirname
            }
          })
          dir.read(err => err && done(err))
        })

        it('should handle errors with callback', () =>
          testHandleErrors(fs, 'fs.dir.read', (_1, _2, _3, cb) => {
            dir.closeSync()
            try {
              dir.read(cb)
            } catch (e) {
              cb(e)
            }
          }, [], agent))

        it('Sync should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            name: 'fs.dir.readsync',
            resource: dirname,
            meta: {
              'file.path': dirname
            }
          })
          dir.readSync()
        })

        it('Sync should handle errors', () =>
          testHandleErrors(fs, 'fs.dir.readsync', (_1, _2, _3, cb) => {
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
            name: 'fs.dir.read',
            resource: dirname,
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
            name: 'fs.dir.close',
            resource: dirname,
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
        } catch (e) { /* */ }
        await fs.promises.unlink(filename)
      })

      describe('appendFile', () => {
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            name: 'fs.filehandle.appendfile',
            resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.writefile',
            resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.readfile',
            resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.write',
            resource: filehandle.fd.toString(),
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
              name: 'fs.filehandle.writev',
              resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.read',
            resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.chmod',
            resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.chown',
            resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.stat',
            resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.sync',
            resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.datasync',
            resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.truncate',
            resource: filehandle.fd.toString(),
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
            name: 'fs.filehandle.utimes',
            resource: filehandle.fd.toString(),
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
        it('should be instrumented', (done) => {
          expectOneSpan(agent, done, {
            name: 'fs.filehandle.close',
            resource: filehandle.fd.toString(),
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
    if (name in realFS) {
      describe(name, () => {
        fn('fs.' + name.toLowerCase(), (fs, args, done, withError) => {
          const span = {}
          return tracer.scope().activate(span, () => {
            args.push((err) => {
              expect(tracer.scope().active()).to.equal(span)
              if (err) {
                if (withError) withError(err)
                else done(err)
              }
            })
            return fs[name].apply(fs, args)
          })
        })
      })
    }

    if (realFS.promises && name in realFS.promises) {
      describe('promises.' + name, () => {
        fn('fs.promises.' + name.toLowerCase(), (fs, args, done, withError) => {
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
        fn('fs.' + nameSync.toLowerCase(), (fs, args, _, withError) => {
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

function mkExpected (props) {
  const meta = Object.assign({ component: 'fs' }, props.meta)
  const expected = Object.assign({ error: 0, service: 'test-fs' }, props)
  expected.meta = meta
  return expected
}

function forOneSpan (agent, fn, done) {
  agent.use(traces => {
    const spans = traces[0]
    let err
    let success
    spans.forEach(span => {
      try {
        fn(span)
        success = true
      } catch (e) {
        err = e
      }
    })
    if (!success) {
      throw err
    }
  }).then(done, done)
}

function expectOneSpan (agent, done, expected) {
  forOneSpan(agent, span => {
    expected = mkExpected(expected)
    const meta = expected.meta
    delete expected.meta
    expect(span.meta).to.include(meta)
    expect(span).to.include(expected)
  }, done)
}

function testHandleErrors (fs, name, tested, args, agent) {
  return new Promise((resolve, reject) => {
    function done (err) {
      if (err) reject(err)
      else resolve()
    }
    tested(fs, args, null, err => {
      expectOneSpan(agent, done, {
        name,
        error: 1,
        meta: {
          'error.type': err.name,
          'error.msg': err.message,
          'error.stack': err.stack
        }
      })
    })
  })
}

function testFileHandleErrors (fs, method, args, filehandle, agent) {
  const name = 'fs.filehandle.' + method.toLowerCase()
  return testHandleErrors(fs, name, (fs, args, _, cb) => {
    filehandle.close()
      .then(() => filehandle[method](...args))
      .catch(cb)
  }, args, agent)
}
