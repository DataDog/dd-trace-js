'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

const realFS = Object.assign({}, require('fs'))
const os = require('os')
const path = require('path')
const semver = require('semver')

const implicitFlag = semver.satisfies(process.versions.node, '>=11.1.0')
const hasWritev = semver.satisfies(process.versions.node, '>=12.9.0')
const hasOSymlink = realFS.constants.O_SYMLINK

wrapIt()

// TODO error cases

describe('fs', () => {
  let fs
  let tmpdir
  afterEach(() => agent.close())
  beforeEach(() => agent.load(plugin, 'fs').then(() => {
    fs = require('fs')
  }))
  before(() => {
    tmpdir = realFS.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-js-test'))
  })
  after(() => {
    realFS.rmdirSync(tmpdir)
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
  })

  describeThreeWays('writeFile', (name, tested) => {
    let filename
    beforeEach(() => {
      filename = path.join(tmpdir, 'writeFile')
    })
    afterEach(() => {
      realFS.unlinkSync(filename)
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
  })

  describeThreeWays('appendFile', (name, tested) => {
    let filename
    beforeEach(() => {
      filename = path.join(tmpdir, 'appendFile')
    })
    afterEach(() => {
      realFS.unlinkSync(filename)
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
  })

  describeThreeWays('copyFile', (name, tested) => {
    const dest = `${__filename}copy`
    afterEach(() => {
      realFS.unlinkSync(dest)
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
          'file.mode': '0o' + mode.toString(8)
        }
      })

      tested(fs, [__filename, mode], done)
    })
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
            'file.mode': '0o' + mode.toString(8)
          }
        })

        tested(fs, [__filename, mode], done)
      })
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
          'file.mode': '0o' + mode.toString(8)
        }
      })

      tested(fs, [fd, mode], done)
    })
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
  })

  describeThreeWays('unlink', (name, tested) => {
    let link
    beforeEach(() => {
      link = path.join(tmpdir, 'link')
      realFS.symlinkSync(__filename, link)
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
  })

  describeThreeWays('symlink', (name, tested) => {
    let link
    beforeEach(() => {
      link = path.join(tmpdir, 'link')
    })
    afterEach(() => {
      realFS.unlinkSync(link)
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
  })

  describeThreeWays('link', (name, tested) => {
    let link
    beforeEach(() => {
      link = path.join(tmpdir, 'link')
    })
    afterEach(() => {
      realFS.unlinkSync(link)
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
  })

  describeThreeWays('rmdir', (name, tested) => {
    let dir
    beforeEach(() => {
      dir = path.join(tmpdir, 'dir')
      realFS.mkdirSync(dir)
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
      realFS.unlinkSync(dest)
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
  })

  describeThreeWays('mkdir', (name, tested) => {
    let dir
    beforeEach(() => {
      dir = path.join(tmpdir, 'mkdir')
    })
    afterEach(() => {
      realFS.rmdirSync(dir)
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
  })

  describe('mkdtemp', () => {
    let tmpdir
    afterEach(() => {
      realFS.rmdirSync(tmpdir)
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
  })

  describe('mkdtempSync', () => {
    let tmpdir
    afterEach(() => {
      realFS.rmdirSync(tmpdir)
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

  if (realFS.promises) {
    describe('FileHandle', () => {
      let filehandle
      let filename
      beforeEach(async () => {
        filename = path.join(os.tmpdir(), 'filehandle')
        await fs.promises.writeFile(filename, 'some data')
        filehandle = await fs.promises.open(filename, 'w+')
      })
      afterEach(async () => {
        try {
          await filehandle.close()
        } catch (e) {
          // we expect an EBADF from the `close` test
          if (e.code !== 'EBADF') {
            throw e
          }
        }
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
      })

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
      })

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
              'file.mode': '0o' + mode.toString(8)
            }
          })
          filehandle.chmod(mode).catch(done)
        })
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
      })
    })
  }
})

function describeThreeWays (name, fn) {
  describe(name, () => {
    fn('fs.' + name.toLowerCase(), (fs, args, done) => {
      args.push((err) => err && done(err))
      return fs[name].apply(fs, args)
    })
  })

  if (realFS.promises && name in realFS.promises) {
    describe('promises.' + name, () => {
      fn('fs.promises.' + name.toLowerCase(), (fs, args, done) => {
        fs.promises[name].apply(fs.promises, args).catch(done)
      })
    })
  }

  const nameSync = name + 'Sync'
  describe(nameSync, () => {
    fn('fs.' + nameSync.toLowerCase(), (fs, args) => {
      return fs[nameSync].apply(fs, args)
    })
  })
}

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
  forOneSpan(agent, span => expect(span).to.deep.include(mkExpected(expected)), done)
}
