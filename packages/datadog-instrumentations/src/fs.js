'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startChannel = channel('apm:fs:operation:start')
const finishChannel = channel('apm:fs:operation:finish')
const errorChannel = channel('apm:fs:operation:error')
const ddFhSym = Symbol('ddFileHandle')
let kHandle, kDirReadPromisified, kDirClosePromisified

// Update packages/dd-trace/src/profiling/profilers/event_plugins/fs.js if you make changes to param names in any of
// the following objects.

const paramsByMethod = {
  access: ['path', 'mode'],
  appendFile: ['path', 'data', 'options'],
  chmod: ['path', 'mode'],
  chown: ['path', 'uid', 'gid'],
  close: ['fd'],
  copyFile: ['src', 'dest', 'mode'],
  cp: ['src', 'dest', 'options'],
  exists: ['path'],
  fchmod: ['fd', 'mode'],
  fchown: ['fd', 'uid', 'gid'],
  fdatasync: ['fd'],
  fstat: ['fd', 'options'],
  fsync: ['fd'],
  ftruncate: ['fd', 'len'],
  futimes: ['fd', 'atime', 'mtime'],
  lchmod: ['path', 'mode'],
  lchown: ['path', 'uid', 'gid'],
  link: ['existingPath', 'newPath'],
  lstat: ['path', 'options'],
  lutimes: ['path', 'atime', 'mtime'],
  mkdir: ['path', 'options'],
  mkdtemp: ['prefix', 'options'],
  open: ['path', 'flag', 'mode'],
  opendir: ['path', 'options'],
  read: ['fd'],
  readdir: ['path', 'options'],
  readFile: ['path', 'options'],
  readlink: ['path', 'options'],
  readv: ['fd'],
  realpath: ['path', 'options'],
  rename: ['oldPath', 'newPath'],
  rmdir: ['path', 'options'],
  rm: ['path', 'options'],
  stat: ['path', 'options'],
  symlink: ['target', 'path', 'type'],
  truncate: ['path', 'len'],
  unlink: ['path'],
  utimes: ['path', 'atime', 'mtime'],
  write: ['fd'],
  writeFile: ['file', 'data', 'options'],
  writev: ['fd']
}

const watchMethods = {
  unwatchFile: ['path', 'listener'],
  watch: ['path', 'options', 'listener'],
  watchFile: ['path', 'options', 'listener']
}

const paramsByFileHandleMethods = {
  appendFile: ['data', 'options'],
  chmod: ['mode'],
  chown: ['uid', 'gid'],
  close: [],
  createReadStream: ['options'],
  createWriteStream: ['options'],
  datasync: [],
  read: ['buffer', 'offset', 'length', 'position'],
  readableWebStream: [],
  readFile: ['options'],
  readLines: ['options'],
  readv: ['buffers', 'position'],
  stat: ['options'],
  sync: [],
  truncate: ['len'],
  utimes: ['atime', 'mtime'],
  write: ['buffer', 'offset', 'length', 'position'],
  writeFile: ['data', 'options'],
  writev: ['buffers', 'position']
}
const names = ['fs', 'node:fs']
for (const name of names) {
  addHook({ name }, fs => {
    const asyncMethods = Object.keys(paramsByMethod)
    const syncMethods = asyncMethods.map(name => `${name}Sync`)

    massWrap(fs, asyncMethods, createWrapFunction())
    massWrap(fs, syncMethods, createWrapFunction())
    massWrap(fs.promises, asyncMethods, createWrapFunction('promises.'))

    wrap(fs.realpath, 'native', createWrapFunction('', 'realpath.native'))
    wrap(fs.realpathSync, 'native', createWrapFunction('', 'realpath.native'))
    wrap(fs.promises.realpath, 'native', createWrapFunction('', 'realpath.native'))

    wrap(fs, 'createReadStream', wrapCreateStream)
    wrap(fs, 'createWriteStream', wrapCreateStream)
    if (fs.Dir) {
      wrap(fs.Dir.prototype, 'close', createWrapFunction('dir.'))
      wrap(fs.Dir.prototype, 'closeSync', createWrapFunction('dir.'))
      wrap(fs.Dir.prototype, 'read', createWrapFunction('dir.'))
      wrap(fs.Dir.prototype, 'readSync', createWrapFunction('dir.'))
      wrap(fs.Dir.prototype, Symbol.asyncIterator, createWrapDirAsyncIterator())
    }

    wrap(fs, 'unwatchFile', createWatchWrapFunction())
    wrap(fs, 'watch', createWatchWrapFunction())
    wrap(fs, 'watchFile', createWatchWrapFunction())

    return fs
  })
}
function isFirstMethodReturningFileHandle (original) {
  return !kHandle && original.name === 'open'
}
function wrapFileHandle (fh) {
  const fileHandlePrototype = getFileHandlePrototype(fh)
  const desc = Reflect.getOwnPropertyDescriptor(fileHandlePrototype, kHandle)
  if (!desc || !desc.get) {
    Reflect.defineProperty(fileHandlePrototype, kHandle, {
      get () {
        return this[ddFhSym]
      },
      set (h) {
        this[ddFhSym] = h
        wrap(this, 'close', createWrapFunction('filehandle.'))
      },
      configurable: true
    })
  }
  for (const name of Reflect.ownKeys(fileHandlePrototype)) {
    if (typeof name !== 'string' || name === 'constructor' || name === 'fd' || name === 'getAsyncId') {
      continue
    }
    wrap(fileHandlePrototype, name, createWrapFunction('filehandle.'))
  }
}

function getFileHandlePrototype (fh) {
  if (!kHandle) {
    kHandle = Reflect.ownKeys(fh).find(key => typeof key === 'symbol' && key.toString().includes('kHandle'))
  }
  return Object.getPrototypeOf(fh)
}

function getSymbolName (sym) {
  return sym.description || sym.toString()
}
function initDirAsyncIteratorProperties (iterator) {
  const keys = Reflect.ownKeys(iterator)
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

function createWrapDirAsyncIterator () {
  return function wrapDirAsyncIterator (asyncIterator) {
    return function wrappedAsyncIterator () {
      if (!kDirReadPromisified || !kDirClosePromisified) {
        initDirAsyncIteratorProperties(this)
      }
      wrap(this, kDirReadPromisified, createWrapFunction('dir.', 'read'))
      wrap(this, kDirClosePromisified, createWrapFunction('dir.', 'close'))
      return Reflect.apply(asyncIterator, this, arguments)
    }
  }
}

function wrapCreateStream (original) {
  const classes = {
    createReadStream: 'ReadStream',
    createWriteStream: 'WriteStream'
  }
  const name = classes[original.name]

  return function (path, options) {
    if (!startChannel.hasSubscribers) return Reflect.apply(original, this, arguments)

    const innerResource = new AsyncResource('bound-anonymous-fn')
    const message = getMessage(name, ['path', 'options'], arguments)

    return innerResource.runInAsyncScope(() => {
      startChannel.publish(message)

      try {
        const stream = Reflect.apply(original, this, arguments)
        const onError = innerResource.bind(error => {
          errorChannel.publish(error)
          onFinish()
        })
        const onFinish = innerResource.bind(() => {
          finishChannel.publish()
          stream.off('close', onFinish)
          stream.off('end', onFinish)
          stream.off('finish', onFinish)
          stream.off('error', onError)
        })

        stream.once('close', onFinish)
        stream.once('end', onFinish)
        stream.once('finish', onFinish)
        stream.once('error', onError)

        return stream
      } catch (err) {
        errorChannel.publish(err)
        finishChannel.publish()
      }
    })
  }
}

function getMethodParamsRelationByPrefix (prefix) {
  if (prefix === 'filehandle.') {
    return paramsByFileHandleMethods
  }
  return paramsByMethod
}

function createWatchWrapFunction (override = '') {
  return function wrapFunction (original) {
    const name = override || original.name
    const method = name
    const operation = name
    return function () {
      if (!startChannel.hasSubscribers) return Reflect.apply(original, this, arguments)
      const message = getMessage(method, watchMethods[operation], arguments, this)
      const innerResource = new AsyncResource('bound-anonymous-fn')
      return innerResource.runInAsyncScope(() => {
        startChannel.publish(message)
        try {
          const result = Reflect.apply(original, this, arguments)
          finishChannel.publish()
          return result
        } catch (err) {
          errorChannel.publish(err)
          finishChannel.publish()
          throw err
        }
      })
    }
  }
}

function createWrapFunction (prefix = '', override = '') {
  return function wrapFunction (original) {
    const name = override || original.name
    const method = `${prefix}${name}`
    const operation = name.match(/^(.+?)(Sync)?(\.native)?$/)[1]

    return function () {
      if (!startChannel.hasSubscribers) return Reflect.apply(original, this, arguments)

      const lastIndex = arguments.length - 1
      const cb = typeof arguments[lastIndex] === 'function' && arguments[lastIndex]
      const innerResource = new AsyncResource('bound-anonymous-fn')
      const params = getMethodParamsRelationByPrefix(prefix)[operation]
      const abortController = new AbortController()
      const message = { ...getMessage(method, params, arguments, this), abortController }

      const finish = innerResource.bind(function (error) {
        if (error !== null && typeof error === 'object') { // fs.exists receives a boolean
          errorChannel.publish(error)
        }
        finishChannel.publish()
      })

      if (cb) {
        const outerResource = new AsyncResource('bound-anonymous-fn')

        arguments[lastIndex] = shimmer.wrapFunction(cb, cb => innerResource.bind(function (e) {
          finish(e)
          return outerResource.runInAsyncScope(() => Reflect.apply(cb, this, arguments))
        }))
      }

      return innerResource.runInAsyncScope(() => {
        startChannel.publish(message)

        if (abortController.signal.aborted) {
          const error = abortController.signal.reason || new Error('Aborted')

          if (prefix === 'promises.') {
            finish(error)
            return Promise.reject(error)
          } else if (name.includes('Sync') || !cb) {
            finish(error)
            throw error
          } else if (cb) {
            arguments[lastIndex](error)
            return
          }
        }

        try {
          const result = Reflect.apply(original, this, arguments)
          if (cb) return result
          if (result && typeof result.then === 'function') {
            // TODO method open returning promise and filehandle prototype not initialized, initialize it

            return result.then(
              value => {
                if (isFirstMethodReturningFileHandle(original)) {
                  wrapFileHandle(value)
                }
                finishChannel.publish()
                return value
              },
              err => {
                errorChannel.publish(err)
                finishChannel.publish()
                throw err
              }
            )
          }

          finishChannel.publish()

          return result
        } catch (err) {
          errorChannel.publish(err)
          finishChannel.publish()
          throw err
        }
      })
    }
  }
}

function getMessage (operation, params, args, self) {
  const metadata = {}
  if (params) {
    for (const [i, param] of params.entries()) {
      if (!param || typeof args[i] === 'function') continue
      metadata[param] = args[i]
    }
  }

  if (self) {
    // For `Dir` the path is available on `this.path`
    if (self.path) {
      metadata.path = self.path
    }
    // For FileHandle fs is available on `this.fd`
    if (self.fd) {
      metadata.fd = self.fd
    }
  }

  return { operation, ...metadata }
}

function massWrap (target, methods, wrapper) {
  for (const method of methods) {
    wrap(target, method, wrapper)
  }
}

function wrap (target, method, wrapper) {
  try {
    shimmer.wrap(target, method, wrapper)
  } catch {
    // skip unavailable method
  }
}
