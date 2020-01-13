'use strict'

let kDirReadPromisified
let kDirClosePromisified

const tagMakers = {
  open: createOpenTags,
  close: createCloseTags,
  readFile: createReadFileTags,
  writeFile: createWriteFileTags,
  appendFile: createAppendFileTags,
  access: createPathTags,
  copyFile: createCopyFileTags,
  stat: createPathTags,
  lstat: createPathTags,
  fstat: createFDTags,
  readdir: createPathTags,
  opendir: createPathTags,
  read: createFDTags,
  write: createFDTags,
  writev: createFDTags,
  chmod: createChmodTags,
  lchmod: createChmodTags,
  fchmod: createFchmodTags,
  chown: createChownTags,
  lchown: createChownTags,
  fchown: createFchownTags,
  realpath: createPathTags,
  readlink: createPathTags,
  unlink: createPathTags,
  symlink: createCopyFileTags,
  link: createCopyFileTags,
  rmdir: createPathTags,
  rename: createCopyFileTags,
  fsync: createFDTags,
  fdatasync: createFDTags,
  mkdir: createPathTags,
  truncate: createPathTags,
  ftruncate: createFDTags,
  utimes: createPathTags,
  futimes: createFDTags,
  mkdtemp: createPathTags
}

function createWrapCreateReadStream (config, tracer) {
  return function wrapCreateReadStream (createReadStream) {
    return function wrappedCreateReadStream (path, options) {
      const tags = makeFSFlagTags(path, options, 'r', config, tracer)
      return tracer.trace('fs.readstream', { tags }, (span, done) => {
        const stream = createReadStream.apply(this, arguments)
        stream.once('end', done)
        stream.once('error', done)
        return stream
      })
    }
  }
}

function createWrapCreateWriteStream (config, tracer) {
  return function wrapCreateWriteStream (createWriteStream) {
    return function wrappedCreateWriteStream (path, options) {
      const tags = makeFSFlagTags(path, options, 'w', config, tracer)
      return tracer.trace('fs.writestream', { tags }, (span, done) => {
        const stream = createWriteStream.apply(this, arguments)
        stream.once('finish', done)
        stream.once('error', done)
        return stream
      })
    }
  }
}

function createWrapExists (config, tracer) {
  return function wrapExists (exists) {
    return function wrappedExists (path, cb) {
      if (typeof cb !== 'function') {
        return exists.apply(this, arguments)
      }
      const tags = makeFSTags(path, null, config, tracer)
      return tracer.trace('fs.exists', { tags }, (span, done) => {
        arguments[1] = function (result) {
          done()
          cb.apply(this, arguments)
        }
        return exists.apply(this, arguments)
      })
    }
  }
}

function createWrapDirRead (config, tracer, sync) {
  const name = sync ? 'fs.dir.readsync' : 'fs.dir.read'
  return function wrapDirRead (read) {
    function options () {
      const tags = makeFSTags(this.path, null, config, tracer)
      return { tags }
    }
    return tracer.wrap(name, options, read)
  }
}

function createWrapDirClose (config, tracer, sync) {
  const name = sync ? 'fs.dir.closesync' : 'fs.dir.close'
  return function wrapDirClose (close) {
    function options () {
      const tags = makeFSTags(this.path, null, config, tracer)
      return { tags }
    }
    return tracer.wrap(name, options, close)
  }
}

function createWrapDirAsyncIterator (config, tracer, instrumenter) {
  return function wrapDirAsyncIterator (asyncIterator) {
    return function wrappedDirAsyncIterator () {
      if (!kDirReadPromisified) {
        const keys = Reflect.ownKeys(this)
        for (const key of keys) {
          if (kDirReadPromisified && kDirClosePromisified) break
          if (typeof key !== 'symbol') continue
          if (!kDirReadPromisified && getSymbolName(key).includes('kDirReadPromisified')) {
            kDirReadPromisified = key
          }
          if (!kDirClosePromisified && getSymbolName(key).includes('kDirClosePromisified')) {
            kDirClosePromisified = key
          }
        }
      }
      instrumenter.wrap(this, kDirReadPromisified, createWrapDirRead(config, tracer))
      instrumenter.wrap(this, kDirClosePromisified, createWrapKDirClose(config, tracer, instrumenter))
      return asyncIterator.call(this)
    }
  }
}

function createWrapKDirClose (config, tracer, instrumenter) {
  return function wrapKDirClose (kDirClose) {
    return function wrappedKDirClose () {
      const tags = makeFSTags(this.path, null, config, tracer)
      return tracer.trace('fs.dir.close', { tags }, (span) => {
        const p = kDirClose.call(this)
        const unwrapBoth = () => {
          instrumenter.unwrap(this, kDirReadPromisified)
          instrumenter.unwrap(this, kDirClosePromisified)
        }
        p.then(unwrapBoth, unwrapBoth)
        return p
      })
    }
  }
}

function createOpenTags (config, tracer) {
  return function openTags (path, flag, mode) {
    if (!flag || typeof flag === 'function') {
      flag = null
    }
    return makeFSFlagTags(path, { flag }, 'r', config, tracer)
  }
}

function createCloseTags (config, tracer) {
  return function closeTags (fd) {
    if (typeof fd !== 'number' || !Number.isInteger(fd)) {
      return
    }
    return makeFSTags(fd, null, config, tracer)
  }
}

function createReadFileTags (config, tracer) {
  return function readFileTags (path, options) {
    return makeFSFlagTags(path, options, 'r', config, tracer)
  }
}

function createWriteFileTags (config, tracer) {
  return function writeFileTags (path, data, options) {
    return makeFSFlagTags(path, options, 'w', config, tracer)
  }
}

function createAppendFileTags (config, tracer) {
  return function appendFileTags (path, data, options) {
    return makeFSFlagTags(path, options, 'a', config, tracer)
  }
}

function createCopyFileTags (config, tracer) {
  return function copyFileTags (src, dest, flag) {
    src = src || 'undefined'
    dest = dest || 'undefined'

    return makeFSTags({ src, dest }, null, config, tracer)
  }
}

function createChmodTags (config, tracer) {
  return function chmodTags (fd, mode) {
    const tags = makeFSTags(fd, null, config, tracer)
    tags['file.mode'] = mode.toString(8)
    return tags
  }
}

function createFchmodTags (config, tracer) {
  return function fchmodTags (fd, mode) {
    if (typeof this === 'object' && this !== null && this.fd) {
      mode = fd
      fd = this.fd
    }

    const tags = makeFSTags(fd, null, config, tracer)
    if (mode) {
      tags['file.mode'] = mode.toString(8)
    }
    return tags
  }
}

function createPathTags (config, tracer) {
  return function pathTags (path) {
    return makeFSTags(path, null, config, tracer)
  }
}

function createFDTags (config, tracer) {
  return function fdTags (fd) {
    if (typeof this === 'object' && this !== null && this.fd) {
      fd = this.fd
    }
    return makeFSTags(fd, null, config, tracer)
  }
}

function createChownTags (config, tracer) {
  return function chownTags (fd, uid, gid) {
    const tags = makeFSTags(fd, null, config, tracer)
    if (uid) {
      tags['file.uid'] = uid.toString()
    }
    if (gid) {
      tags['file.gid'] = gid.toString()
    }
    return tags
  }
}

function createFchownTags (config, tracer) {
  return function fchownTags (fd, uid, gid) {
    if (typeof this === 'object' && this !== null && this.fd) {
      gid = uid
      uid = fd
      fd = this.fd
    }
    const tags = makeFSTags(fd, null, config, tracer)
    if (typeof uid === 'number') {
      tags['file.uid'] = uid.toString()
    }
    if (typeof gid === 'number') {
      tags['file.gid'] = gid.toString()
    }
    return tags
  }
}

function getSymbolName (sym) {
  return sym.description || sym.toString()
}

function createWrapCb (tracer, config, name, tagMaker) {
  const makeTags = tagMaker(config, tracer)
  name = 'fs.' + name
  return function wrapFunction (fn) {
    return tracer.wrap(name.toLowerCase(), function () {
      if (typeof arguments[arguments.length - 1] !== 'function') {
        return
      }
      const tags = makeTags.apply(this, arguments)
      return tags ? { tags } : null
    }, fn)
  }
}

function createWrap (tracer, config, name, tagMaker) {
  const makeTags = tagMaker(config, tracer)
  name = 'fs.' + name
  return function wrapSyncFunction (fn) {
    return tracer.wrap(name.toLowerCase(), function () {
      const tags = makeTags.apply(this, arguments)
      return tags ? { tags } : null
    }, fn)
  }
}

function makeFSFlagTags (path, options, defaultFlag, config, tracer) {
  const tags = makeFSTags(path, options, config, tracer)

  if (tags) {
    let flag = defaultFlag
    if (typeof options === 'object' && options !== null) {
      if (options.flag) {
        flag = options.flag
      } else if (options.flags) {
        flag = options.flags
      }
    }
    tags['file.flag'] = flag
    return tags
  }
}

function makeFSTags (path, options, config, tracer) {
  path = options && 'fd' in options ? options.fd : path
  const tags = {
    'component': 'fs',
    'service.name': config.service || `${tracer._service}-fs`
  }

  switch (typeof path) {
    case 'object': {
      if (path === null) return
      const src = 'src' in path ? path.src : null
      const dest = 'dest' in path ? path.dest : null
      if (src || dest) {
        tags['file.src'] = src.toString('utf8')
        tags['file.dest'] = dest.toString('utf8')
        tags['resource.name'] = (src || dest).toString('utf8')
      } else {
        tags['file.path'] = path.toString('utf8')
        tags['resource.name'] = path.toString('utf8')
      }
      break
    }
    case 'string': {
      tags['file.path'] = path
      tags['resource.name'] = path
      break
    }
    case 'number': {
      tags['file.descriptor'] = path
      tags['resource.name'] = path.toString()
      break
    }
    default:
      if (path && typeof path.toString === 'function') {
        const pathStr = path.toString()
        tags['resource.name'] = pathStr
      } else {
        tags['resource.name'] = 'undefined'
      }
  }

  return tags
}

function getFileHandlePrototype (fs) {
  return fs.promises.open(__filename, 'r')
    .then(fh => {
      fh.close()
      return Object.getPrototypeOf(fh)
    })
}

function patchClassicFunctions (fs, tracer, config) {
  for (const name in fs) {
    if (!fs[name]) continue
    const tagMakerName = name.endsWith('Sync') ? name.substr(0, name.length - 4) : name
    if (tagMakerName in tagMakers) {
      const tagMaker = tagMakers[tagMakerName]
      if (name.endsWith('Sync')) {
        this.wrap(fs, name, createWrap(tracer, config, name, tagMaker))
      } else {
        this.wrap(fs, name, createWrapCb(tracer, config, name, tagMaker))
      }
    }
  }
}

function patchFileHandle (fs, tracer, config) {
  getFileHandlePrototype(fs).then(fileHandlePrototype => {
    for (const name of Reflect.ownKeys(fileHandlePrototype)) {
      if (name === 'constructor' || name === 'fd' || name === 'getAsyncId') {
        continue
      }
      let tagMaker
      const fName = 'f' + name
      if (fName in tagMakers) {
        tagMaker = tagMakers[fName]
      } else {
        tagMaker = createFDTags
      }
      this.wrap(fileHandlePrototype, name, createWrap(tracer, config, 'filehandle.' + name, tagMaker))
    }
  })
}

function patchPromiseFunctions (fs, tracer, config) {
  for (const name in fs.promises) {
    if (name in tagMakers) {
      const tagMaker = tagMakers[name]
      this.wrap(fs.promises, name, createWrap(tracer, config, 'promises.' + name.toLowerCase(), tagMaker))
      this.wrap(fs.promises, name, createWrap(tracer, config, 'promises.' + name, tagMaker))
    }
  }
}

function patchDirFunctions (fs, tracer, config) {
  this.wrap(fs.Dir.prototype, 'close', createWrapDirClose(config, tracer))
  this.wrap(fs.Dir.prototype, 'closeSync', createWrapDirClose(config, tracer, true))
  this.wrap(fs.Dir.prototype, 'read', createWrapDirRead(config, tracer))
  this.wrap(fs.Dir.prototype, 'readSync', createWrapDirRead(config, tracer, true))
  this.wrap(fs.Dir.prototype, Symbol.asyncIterator, createWrapDirAsyncIterator(config, tracer, this))
}

function unpatchClassicFunctions (fs) {
  for (const name in fs) {
    if (!fs[name]) continue
    const tagMakerName = name.endsWith('Sync') ? name.substr(0, name.length - 4) : name
    if (tagMakerName in tagMakers) {
      this.unwrap(fs, name)
    }
  }
}

function unpatchFileHandle (fs) {
  getFileHandlePrototype(fs).then(fileHandlePrototype => {
    for (const name of Reflect.ownKeys(fileHandlePrototype)) {
      if (name === 'constructor' || name === 'fd' || name === 'getAsyncId') {
        continue
      }
      this.unwrap(fileHandlePrototype, name)
    }
  })
}

function unpatchPromiseFunctions (fs) {
  for (const name in fs.promises) {
    if (name in tagMakers) {
      this.unwrap(fs.promises, name)
    }
  }
}

function unpatchDirFunctions (fs) {
  this.unwrap(fs.Dir.prototype, 'close')
  this.unwrap(fs.Dir.prototype, 'closeSync')
  this.unwrap(fs.Dir.prototype, 'read')
  this.unwrap(fs.Dir.prototype, 'readSync')
  this.unwrap(fs.Dir.prototype, Symbol.asyncIterator)
}

module.exports = {
  name: 'fs',
  patch (fs, tracer, config) {
    patchClassicFunctions.call(this, fs, tracer, config)
    if (fs.promises) {
      patchFileHandle.call(this, fs, tracer, config)
      patchPromiseFunctions.call(this, fs, tracer, config)
    }
    if (fs.Dir) {
      patchDirFunctions.call(this, fs, tracer, config)
    }
    this.wrap(fs, 'createReadStream', createWrapCreateReadStream(config, tracer))
    this.wrap(fs, 'createWriteStream', createWrapCreateWriteStream(config, tracer))
    this.wrap(fs, 'existsSync', createWrap(tracer, config, 'existssync', createPathTags))
    this.wrap(fs, 'exists', createWrapExists(config, tracer))
  },
  unpatch (fs) {
    unpatchClassicFunctions.call(this, fs)
    if (fs.promises) {
      unpatchFileHandle.call(this, fs)
      unpatchPromiseFunctions.call(this, fs)
    }
    if (fs.Dir) {
      unpatchDirFunctions.call(this, fs)
    }
    this.unwrap(fs, 'createReadStream')
    this.unwrap(fs, 'createWriteStream')
    this.unwrap(fs, 'existsSync')
    this.unwrap(fs, 'exists')
  }
}

/** TODO fs functions:

unwatchFile
watch
watchFile
*/
