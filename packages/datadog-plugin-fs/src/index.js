'use strict'

function createWrapCreateReadStream (config, tracer) {
  return function wrapCreateReadStream (createReadStream) {
    return function wrappedCreateReadStream (path, options) {
      path = options && 'fd' in options ? options.fd : path
      const tags = makeFSTags(path, options, 'r', config, tracer)
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
      path = options && 'fd' in options ? options.fd : path
      const tags = makeFSTags(path, options, 'w', config, tracer)
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
      if (typeof path === 'number' || typeof cb !== 'function') {
        return exists.apply(this, arguments)
      }
      const tags = makeFSTags(path, null, null, config, tracer)
      return tracer.trace('fs.exists', { tags }, (span, done) => {
        arguments[arguments.length - 1] = function (result) {
          done()
          cb.apply(this, arguments)
        }
        return exists.apply(this, arguments)
      })
    }
  }
}

function createOpenTags (config, tracer) {
  return function openTags (path, flag, mode) {
    if (!flag || typeof flag === 'function') {
      flag = null
    }
    return makeFSTags(path, { flag }, 'r', config, tracer)
  }
}

function createCloseTags (config, tracer) {
  return function closeTags (fd) {
    if (typeof fd !== 'number' || !Number.isInteger(fd)) {
      return
    }
    return makeFSTags(fd, null, null, config, tracer)
  }
}

function createReadFileTags (config, tracer) {
  return function readFileTags (path, options) {
    return makeFSTags(path, options, 'r', config, tracer)
  }
}

function createWriteFileTags (config, tracer) {
  return function writeFileTags (path, data, options) {
    return makeFSTags(path, options, 'w', config, tracer)
  }
}

function createAppendFileTags (config, tracer) {
  return function appendFileTags (path, data, options) {
    return makeFSTags(path, options, 'a', config, tracer)
  }
}

function createCopyFileTags (config, tracer) {
  return function copyFileTags (src, dest, flag) {
    if (!src || !dest) {
      return
    }
    const tags = makeFSTags(src, null, null, config, tracer)
    delete tags['file.path']
    tags['file.src'] = src.toString('utf8')
    tags['file.dest'] = dest.toString('utf8')
    return tags
  }
}

function createChmodTags (config, tracer) {
  return function chmodTags (path, mode) {
    if (typeof path === 'number' || typeof mode !== 'number') {
      return
    }
    const tags = makeFSTags(path, null, null, config, tracer)
    tags['file.mode'] = '0o' + mode.toString(8)
    return tags
  }
}

function createFchmodTags (config, tracer) {
  return function fchmodTags (fd, mode) {
    if (typeof this === 'object' && this !== null && this.fd) {
      fd = this.fd
    }
    if (typeof fd !== 'number' || typeof mode !== 'number') {
      return
    }
    const tags = makeFSTags(fd, null, null, config, tracer)
    tags['file.mode'] = '0o' + mode.toString(8)
    return tags
  }
}

function createPathTags (config, tracer) {
  return function pathTags (path) {
    if (typeof path === 'number') {
      return
    }
    return makeFSTags(path, null, null, config, tracer)
  }
}

function createFDTags (config, tracer) {
  return function fdTags (fd) {
    if (typeof this === 'object' && this !== null && this.fd) {
      fd = this.fd
    }
    if (typeof fd !== 'number') {
      return
    }
    return makeFSTags(fd, null, null, config, tracer)
  }
}

function createChownTags (config, tracer) {
  return function chownTags (path, uid, gid) {
    if (typeof path === 'number' || typeof uid !== 'number' || typeof gid !== 'number') {
      return
    }
    const tags = makeFSTags(path, null, null, config, tracer)
    tags['file.uid'] = uid.toString()
    tags['file.gid'] = gid.toString()
    return tags
  }
}

function createFchownTags (config, tracer) {
  return function fchownTags (fd, uid, gid) {
    if (typeof this === 'object' && this !== null && this.fd) {
      fd = this.fd
    }
    if (typeof fd !== 'number' || typeof uid !== 'number' || typeof gid !== 'number') {
      return
    }
    const tags = makeFSTags(fd, null, null, config, tracer)
    tags['file.uid'] = uid.toString()
    tags['file.gid'] = gid.toString()
    return tags
  }
}

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

function createWrapCb (tracer, config, name, tagMaker) {
  const makeTags = tagMaker(config, tracer)
  name = 'fs.' + name
  return function wrapFunction (fn) {
    return function wrappedFunction () {
      const cb = arguments[arguments.length - 1]
      if (typeof cb !== 'function') {
        return fn.apply(this, arguments)
      }
      const tags = makeTags.apply(this, arguments)
      if (!tags) {
        return fn.apply(this, arguments)
      }
      return tracer.trace(name, { tags }, (span, done) => {
        arguments[arguments.length - 1] = wrapCallback(cb, done)
        return fn.apply(this, arguments)
      })
    }
  }
}

function createWrap (tracer, config, name, tagMaker) {
  const makeTags = tagMaker(config, tracer)
  name = 'fs.' + name
  return function wrapSyncFunction (fn) {
    return function wrappedSyncFunction () {
      const tagArgs = Array.from(arguments)
      if (name.indexOf('filehandle') > -1) {
        tagArgs.unshift(null)
      }
      const tags = makeTags.apply(this, tagArgs)
      if (!tags) {
        return fn.apply(this, arguments)
      }
      return tracer.trace(name, { tags }, (span) => {
        return fn.apply(this, arguments)
      })
    }
  }
}

function makeFSTags (path, options, defaultFlag, config, tracer) {
  if (
    typeof path !== 'number' &&
    typeof path !== 'string' &&
    (typeof path !== 'object' || path === null)
  ) {
    return
  }
  const tags = {
    'component': 'fs',
    'resource.name': path.toString(typeof path === 'number' ? 10 : 'utf8'),
    'service.name': config.service || `${tracer._service}-fs`
  }
  if (defaultFlag) {
    tags['file.flag'] = options && options.flag
      ? options.flag
      : (options && options.flags ? options.flags : defaultFlag)
  }
  if (typeof path === 'number' && Number.isInteger(path)) {
    tags['file.descriptor'] = path
  } else {
    tags['file.path'] = path.toString('utf8')
  }
  return tags
}

function wrapCallback (cb, done) {
  return function wrappedCallback (err, result) {
    done(err)
    return cb.apply(null, arguments)
  }
}

async function getFileHandlePrototype(fs) {
  const fh = await fs.promises.open(__filename, 'r')
  await fh.close()
  return Object.getPrototypeOf(fh)
}

module.exports = {
  name: 'fs',
  patch (fs, tracer, config) {
    for (const name in fs) {
      const tagMakerName = name.endsWith('Sync') ? name.substr(0, name.length - 4) : name
      if (tagMakerName in tagMakers) {
        const tagMaker = tagMakers[tagMakerName]
        if (name.endsWith('Sync')) {
          this.wrap(fs, name, createWrap(tracer, config, name.toLowerCase(), tagMaker))
        } else {
          this.wrap(fs, name, createWrapCb(tracer, config, name.toLowerCase(), tagMaker))
        }
      }
    }
    if (fs.promises) {
      for (const name in fs.promises) {
        if (name in tagMakers) {
          const tagMaker = tagMakers[name]
          this.wrap(fs.promises, name, createWrap(tracer, config, 'promises.' + name.toLowerCase(), tagMaker))
        }
      }
      getFileHandlePrototype(fs).then(fileHandlePrototype => {
        for (const name of Reflect.ownKeys(fileHandlePrototype)) {
          if (name === 'constructor' || name === 'fd' || name === 'getAsyncId') {
            continue
          }
          let tagMaker
          if ('f'+name in tagMakers) {
            tagMaker = tagMakers['f'+ name]
          } else {
            tagMaker = createFDTags
          }
          this.wrap(fileHandlePrototype, name, createWrap(tracer, config, 'filehandle.' + name.toLowerCase(), tagMaker))

        }
      }).catch(e => console.error(e))
    }
    this.wrap(fs, 'createReadStream', createWrapCreateReadStream(config, tracer))
    this.wrap(fs, 'createWriteStream', createWrapCreateWriteStream(config, tracer))
    this.wrap(fs, 'existsSync', createWrap(tracer, config, 'existssync', createPathTags))
    this.wrap(fs, 'exists', createWrapExists(config, tracer))
  },
  unpatch (fs) {
    for (const name in fs) {
      const tagMakerName = name.endsWith('Sync') ? name.substr(0, name.length - 4) : name
      if (tagMakerName in tagMakers) {
        this.unwrap(fs, name)
      }
    }
    if (fs.promises) {
      for (const name in fs.promises) {
        if (name in tagMakers) {
          this.unwrap(fs.promises, name)
        }
      }
      getFileHandlePrototype(fs).then(fileHandlePrototype => {
        for (const name of Reflect.ownKeys(fileHandlePrototype)) {
          if (name === 'constructor' || name === 'fd' || name === 'getAsyncId') {
            continue
          }
          this.unwrap(fileHandlePrototype, name)
        }
      })
    }
    this.unwrap(fs, 'createReadStream')
    this.unwrap(fs, 'createWriteStream')
    this.unwrap(fs, 'existsSync')
    this.unwrap(fs, 'exists')
  }
}

/** TODO fs functions:

opendir
opendirSync
unwatchFile
watch
watchFile
*/
