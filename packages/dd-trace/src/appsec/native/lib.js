'use strict'

const os = require('os')
const path = require('path')
const { family, GLIBC, MUSL } = require('detect-libc')

const LIB_VERSION = '1.1.2'
const libRoot = path.join(__dirname, '..', '..', '..', '..', '..', 'lib')

// TODO(vdeturckheim): When we have anew iteration of this lib, remove Sqreen naming

module.exports = {
  // include is the same for all platform
  include: path.join(libRoot, `SqreenLibrary-${LIB_VERSION}-Darwin-x86_64`, 'include'),
  lib: getLibPath()
}

function getLibPath () {
  switch (os.platform()) {
    case 'linux':
      if (family === GLIBC) {
        return path.join(libRoot, `SqreenLibrary-${LIB_VERSION}-Linux-x86_64-glibc`, 'lib64', 'libsqreen.a')
      } else if (family === MUSL) {
        return path.join(libRoot, `SqreenLibrary-${LIB_VERSION}-Linux-x86_64-muslc`, 'lib64', 'libsqreen.a')
      }
      break
    case 'win32':
      return path.join(libRoot, `SqreenLibrary-${LIB_VERSION}-Windows-AMD64`, 'lib', 'SqreenStatic.lib')
    case 'darwin':
      return path.join(libRoot, `SqreenLibrary-${LIB_VERSION}-Darwin-x86_64`, 'lib', 'libsqreen.a')
    default:
      return ''
  }
}
