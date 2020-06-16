'use strict'

let kDirReadPromisified
let kDirClosePromisified
let kHandle

const ddFhSym = Symbol('ddFileHandle')

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

const promisifiable = ['read', 'readv', 'write', 'writev']

const orphanable = false

function createWrapCreateReadStream (config, tracer) {
  return function wrapCreateReadStream (createReadStream) {
    return function createReadStreamWithTrace (path, options) {
      if (!hasParent(tracer)) {
        return createReadStream.apply(this, arguments)
      }
      const tags = makeFSFlagTags('ReadStream', path, options, 'r', config, tracer)
      return tracer.trace('fs.operation', { tags, orphanable }, (span, done) => {
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
    return function createWriteStreamWithTrace (path, options) {
      const tags = makeFSFlagTags('WriteStream', path, options, 'w', config, tracer)
      return tracer.trace('fs.operation', { tags, orphanable }, (span, done) => {
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
    const existsWithTrace = function existsWithTrace (path, cb) {
      if (typeof cb !== 'function') {
        return exists.apply(this, arguments)
      }
      const tags = makeFSTags('exists', path, null, config, tracer)
      return tracer.trace('fs.operation', { tags, orphanable }, (span, done) => {
        arguments[1] = function (result) {
          done()
          cb.apply(this, arguments)
        }
        return exists.apply(this, arguments)
      })
    }

    copySymbols(exists, existsWithTrace)

    return existsWithTrace
  }
}

function createWrapDirRead (config, tracer, sync) {
  const name = sync ? 'dir.readSync' : 'dir.read'
  return function wrapDirRead (read) {
    function options () {
      const tags = makeFSTags(name, this.path, null, config, tracer)
      return { tags, orphanable }
    }
    return tracer.wrap('fs.operation', options, read, true)
  }
}

function createWrapDirClose (config, tracer, sync) {
  const name = sync ? 'dir.closeSync' : 'dir.close'
  return function wrapDirClose (close) {
    function options () {
      const tags = makeFSTags(name, this.path, null, config, tracer)
      return { tags, orphanable }
    }
    return tracer.wrap('fs.operation', options, close, true)
  }
}

function createWrapDirAsyncIterator (config, tracer, instrumenter) {
  return function wrapDirAsyncIterator (asyncIterator) {
    return function asyncIteratorWithTrace () {
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
    return function kDirCloseWithTrace () {
      const tags = makeFSTags('dir.close', this.path, null, config, tracer)
      return tracer.trace('fs.operation', { tags, orphanable }, (span) => {
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

function createOpenTags (resourceName, config, tracer) {
  return function openTags (path, flag, mode) {
    if (!flag || typeof flag === 'function') {
      flag = null
    }
    return makeFSFlagTags(resourceName, path, { flag }, 'r', config, tracer)
  }
}

function createCloseTags (resourceName, config, tracer) {
  return function closeTags (fd) {
    if (typeof fd === 'undefined' && this && this[ddFhSym]) {
      fd = this[ddFhSym].fd
    }
    if (typeof fd !== 'number' || !Number.isInteger(fd)) {
      return
    }
    return makeFSTags(resourceName, fd, null, config, tracer)
  }
}

function createReadFileTags (resourceName, config, tracer) {
  return function readFileTags (path, options) {
    return makeFSFlagTags(resourceName, path, options, 'r', config, tracer)
  }
}

function createWriteFileTags (resourceName, config, tracer) {
  return function writeFileTags (path, data, options) {
    return makeFSFlagTags(resourceName, path, options, 'w', config, tracer)
  }
}

function createAppendFileTags (resourceName, config, tracer) {
  return function appendFileTags (path, data, options) {
    return makeFSFlagTags(resourceName, path, options, 'a', config, tracer)
  }
}

function createCopyFileTags (resourceName, config, tracer) {
  return function copyFileTags (src, dest, flag) {
    return makeFSTags(resourceName, { src, dest }, null, config, tracer)
  }
}

function createChmodTags (resourceName, config, tracer) {
  return function chmodTags (fd, mode) {
    const tags = makeFSTags(resourceName, fd, null, config, tracer)
    tags['file.mode'] = mode.toString(8)
    return tags
  }
}

function createFchmodTags (resourceName, config, tracer) {
  return function fchmodTags (fd, mode) {
    if (typeof this === 'object' && this !== null && this.fd) {
      mode = fd
      fd = this.fd
    }

    const tags = makeFSTags(resourceName, fd, null, config, tracer)
    if (mode) {
      tags['file.mode'] = mode.toString(8)
    }
    return tags
  }
}

function createPathTags (resourceName, config, tracer) {
  return function pathTags (path) {
    return makeFSTags(resourceName, path, null, config, tracer)
  }
}

function createFDTags (resourceName, config, tracer) {
  return function fdTags (fd) {
    if (typeof this === 'object' && this !== null && this.fd) {
      fd = this.fd
    }
    return makeFSTags(resourceName, fd, null, config, tracer)
  }
}

function createChownTags (resourceName, config, tracer) {
  return function chownTags (fd, uid, gid) {
    const tags = makeFSTags(resourceName, fd, null, config, tracer)
    if (typeof uid === 'number') {
      tags['file.uid'] = uid.toString()
    }
    if (typeof gid === 'number') {
      tags['file.gid'] = gid.toString()
    }
    return tags
  }
}

function createFchownTags (resourceName, config, tracer) {
  return function fchownTags (fd, uid, gid) {
    if (typeof this === 'object' && this !== null && this.fd) {
      gid = uid
      uid = fd
      fd = this.fd
    }
    const tags = makeFSTags(resourceName, fd, null, config, tracer)
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

function hasParent (tracer) {
  return !!tracer.scope().active()
}

function createWrapCb (tracer, config, name, tagMaker) {
  const makeTags = tagMaker(name, config, tracer)
  return function wrapFunction (fn) {
    return tracer.wrap('fs.operation', function () {
      if (typeof arguments[arguments.length - 1] !== 'function') {
        return
      }
      const tags = makeTags.apply(this, arguments)
      return tags ? { tags, orphanable } : { orphanable }
    }, fn, true)
  }
}

function createWrap (tracer, config, name, tagMaker) {
  const makeTags = tagMaker(name, config, tracer)

  return function wrapSyncFunction (fn) {
    return tracer.wrap('fs.operation', function () {
      const tags = makeTags.apply(this, arguments)
      return tags ? { tags, orphanable } : { orphanable }
    }, fn, true)
  }
}

function makeFSFlagTags (resourceName, path, options, defaultFlag, config, tracer) {
  const tags = makeFSTags(resourceName, path, options, config, tracer)

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

function makeFSTags (resourceName, path, options, config, tracer) {
  path = options && typeof options === 'object' && 'fd' in options ? options.fd : path
  const tags = {
    'component': 'fs',
    'span.kind': 'internal',
    'resource.name': resourceName,
    'service.name': config.service || `${tracer._service}-fs`
  }

  switch (typeof path) {
    case 'object': {
      if (path === null) return
      const src = 'src' in path ? path.src : null
      const dest = 'dest' in path ? path.dest : null
      if (src || dest) {
        tags['file.src'] = src
        tags['file.dest'] = dest
      } else {
        tags['file.path'] = path
      }
      break
    }
    case 'string': {
      tags['file.path'] = path
      break
    }
    case 'number': {
      tags['file.descriptor'] = path.toString()
      break
    }
  }

  return tags
}

function copySymbols (from, to) {
  const props = Object.getOwnPropertyDescriptors(from)
  const keys = Reflect.ownKeys(props)

  for (const key of keys) {
    if (typeof key !== 'symbol' || to.hasOwnProperty(key)) continue

    Object.defineProperty(to, key, props[key])
  }
}

function getFileHandlePrototype (fs) {
  return fs.promises.open(__filename, 'r')
    .then(fh => {
      if (!kHandle) {
        kHandle = Reflect.ownKeys(fh).find(key => typeof key === 'symbol' && key.toString().includes('kHandle'))
      }
      fh.close()

      return Object.getPrototypeOf(fh)
    })
}

function patchClassicFunctions (fs, tracer, config) {
  for (const name in fs) {
    if (!fs[name]) continue
    const tagMakerName = name.endsWith('Sync') ? name.substr(0, name.length - 4) : name
    const original = fs[name]
    if (tagMakerName in tagMakers) {
      const tagMaker = tagMakers[tagMakerName]
      if (name.endsWith('Sync')) {
        this.wrap(fs, name, createWrap(tracer, config, name, tagMaker))
      } else {
        this.wrap(fs, name, createWrapCb(tracer, config, name, tagMaker))
      }
      if (name in promisifiable) {
        copySymbols(original, fs[name])
      }
    }
  }
}

function patchFileHandle (fs, tracer, config) {
  getFileHandlePrototype(fs).then((fileHandlePrototype) => {
    for (const name of Reflect.ownKeys(fileHandlePrototype)) {
      if (typeof name !== 'string' || name === 'constructor' || name === 'fd' || name === 'getAsyncId') {
        continue
      }
      let tagMaker
      const fName = 'f' + name
      if (fName in tagMakers) {
        tagMaker = tagMakers[fName]
      } else {
        tagMaker = createFDTags
      }

      const instrumenter = this

      const desc = Reflect.getOwnPropertyDescriptor(fileHandlePrototype, kHandle)
      if (!desc || !desc.get) {
        Reflect.defineProperty(fileHandlePrototype, kHandle, {
          get () {
            return this[ddFhSym]
          },
          set (h) {
            this[ddFhSym] = h
            instrumenter.wrap(this, 'close', createWrap(tracer, config, 'filehandle.close', tagMakers.close))
          },
          configurable: true
        })
      }

      this.wrap(fileHandlePrototype, name, createWrap(tracer, config, 'filehandle.' + name, tagMaker))
    }
  })
}

function patchPromiseFunctions (fs, tracer, config) {
  for (const name in fs.promises) {
    if (name in tagMakers) {
      const tagMaker = tagMakers[name]
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
      if (typeof name !== 'string' || name === 'constructor' || name === 'fd' || name === 'getAsyncId') {
        continue
      }
      this.unwrap(fileHandlePrototype, name)
    }
    delete fileHandlePrototype[kHandle]
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
    this.wrap(fs, 'existsSync', createWrap(tracer, config, 'existsSync', createPathTags))
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
