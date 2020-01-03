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

  describeBoth('close', (name, tested) => {
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

  describeBoth('readFile', (name, tested) => {
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

  describeBoth('writeFile', (name, tested) => {
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

  describeBoth('appendFile', (name, tested) => {
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

  describeBoth('access', (name, tested) => {
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

  describeBoth('copyFile', (name, tested) => {
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

  describeBoth('stat', (name, tested) => {
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

  describeBoth('lstat', (name, tested) => {
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

  describeBoth('fstat', (name, tested) => {
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

  describeBoth('readdir', (name, tested) => {
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

  describeBoth('read', (name, tested) => {
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

  describeBoth('write', (name, tested) => {
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
    describeBoth('writev', (name, tested) => {
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

  describeBoth('chmod', (name, tested) => {
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
    describeBoth('lchmod', (name, tested) => {
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

  describeBoth('fchmod', (name, tested) => {
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

  describeBoth('chown', (name, tested) => {
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
    describeBoth('lchown', (name, tested) => {
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

  describeBoth('fchown', (name, tested) => {
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

  describeBoth('realpath', (name, tested) => {
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

  describeBoth('readlink', (name, tested) => {
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

  describeBoth('unlink', (name, tested) => {
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

  describeBoth('symlink', (name, tested) => {
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

  describeBoth('link', (name, tested) => {
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

  describeBoth('rmdir', (name, tested) => {
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

  describeBoth('rename', (name, tested) => {
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

  describeBoth('fsync', (name, tested) => {
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

  describeBoth('fdatasync', (name, tested) => {
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

  describeBoth('mkdir', (name, tested) => {
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

  describeBoth('truncate', (name, tested) => {
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

  describeBoth('ftruncate', (name, tested) => {
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

  describeBoth('utimes', (name, tested) => {
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

  describeBoth('futimes', (name, tested) => {
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
})

function describeBoth (name, fn) {
  describe(name, () => {
    fn('fs.' + name.toLowerCase(), (fs, args, done) => {
      args.push((err) => err && done(err))
      return fs[name].apply(fs, args)
    })
  })

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
