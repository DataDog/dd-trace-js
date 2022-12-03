
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

// TODO: unwatchFile, watch, watchFile
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

addHook({ name: 'fs' }, fs => {
  const asyncMethods = Object.keys(paramsByMethod)
  const syncMethods = asyncMethods.map(name => `${name}Sync`)

  massWrap(fs, asyncMethods, createWrapFunction())
  massWrap(fs, syncMethods, createWrapFunction())
  massWrap(fs.promises, asyncMethods, createWrapFunction('promises.'))

  wrap(fs.realpath, 'native', createWrapFunction('', 'realpath.native'))
  wrap(fs.realpathSync, 'native', createWrapFunction('', 'realpath.native'))
  wrap(fs.promises.realpath, 'native', createWrapFunction('', 'realpath.native'))

  wrap(fs, 'createReadStream', createWrapCreateStream())
  wrap(fs, 'createWriteStream', createWrapCreateStream())

  wrap(fs.Dir.prototype, 'close', createWrapFunction('dir.'))
  wrap(fs.Dir.prototype, 'closeSync', createWrapFunction('dir.'))
  wrap(fs.Dir.prototype, 'read', createWrapFunction('dir.'))
  wrap(fs.Dir.prototype, 'readSync', createWrapFunction('dir.'))
  // shimmer.wrap(fs.Dir.prototype, Symbol.asyncIterator, createWrapDirAsyncIterator(config, tracer, this))

  // shimmer.wrap(fs, 'watch', wrapWatch)
  // shimmer.wrap(fs, 'watchFile', wrapWatch)
  // shimmer.wrap(fs, 'unwatchFile', wrapWatch)

  return fs
})

function createWrapCreateStream () {
  return function wrapCreateStream (original) {
    const classes = {
      createReadStream: 'ReadStream',
      createWriteStream: 'WriteStream'
    }
    const name = classes[original.name]

    return function (path, options) {
      if (!startChannel.hasSubscribers) return original.apply(this, arguments)

      const innerResource = new AsyncResource('bound-anonymous-fn')
      const message = getMessage(name, ['path', 'options'], arguments)

      return innerResource.runInAsyncScope(() => {
        startChannel.publish(message)

        try {
          const stream = original.apply(this, arguments)
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
        } catch (error) {
          errorChannel.publish(error)
          finishChannel.publish()
        }
      })
    }
  }
}

// TODO: equivalent of datadog:fs:access
function createWrapFunction (prefix = '', override = '') {
  return function wrapFunction (original) {
    const name = override || original.name
    const method = `${prefix}${name}`
    const operation = name.match(/^(.+?)(Sync)?(\.native)?$/)[1]

    return function () {
      if (!startChannel.hasSubscribers) return original.apply(this, arguments)

      const lastIndex = arguments.length - 1
      const cb = typeof arguments[lastIndex] === 'function' && arguments[lastIndex]
      const innerResource = new AsyncResource('bound-anonymous-fn')
      const message = getMessage(method, paramsByMethod[operation], arguments, this)

      if (cb) {
        const outerResource = new AsyncResource('bound-anonymous-fn')

        arguments[lastIndex] = innerResource.bind(function (e) {
          if (typeof e === 'object') { // fs.exists receives a boolean
            errorChannel.publish(e)
          }

          finishChannel.publish()

          return outerResource.runInAsyncScope(() => cb.apply(this, arguments))
        })
      }

      return innerResource.runInAsyncScope(() => {
        startChannel.publish(message)

        try {
          const result = original.apply(this, arguments)

          if (cb) return result
          if (result && typeof result.then === 'function') {
            return result.then(
              value => {
                finishChannel.publish()
                return value
              },
              error => {
                errorChannel.publish(error)
                finishChannel.publish()
                throw error
              }
            )
          }

          finishChannel.publish()

          return result
        } catch (error) {
          errorChannel.publish(error)
          finishChannel.publish()
          throw error
        }
      })
    }
  }
}

// TODO: the operation should be the fs operation name not the method name
function getMessage (operation, params, args, self) {
  const metadata = {}

  for (let i = 0; i < params.length; i++) {
    if (!params[i] || typeof args[i] === 'function') continue
    metadata[params[i]] = args[i]
  }

  // For `Dir` the path is available on `this.path`
  if (self && self.path) {
    metadata.path = self.path
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
  } catch (e) {
    // skip unavailable method
  }
}
