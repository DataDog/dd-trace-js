'use strict'
const { family, GLIBC, MUSL } = require('detect-libc')
const os = require('os')
const path = require('path')

const LIB_VERSION = '1.1.2'

// TODO(vdeturckheim): When we have anew iteration of this lib, remove Sqreen naming

module.exports = {
  // include is the same for all platform
  include: path.join(__dirname, `SqreenLibrary-${LIB_VERSION}-Darwin-x86_64`, 'include'),
  lib: ''
}

if (os.platform() === 'darwin') {
  module.exports.lib = path.join(__dirname, `SqreenLibrary-${LIB_VERSION}-Darwin-x86_64`, 'lib', 'libsqreen.a')
}
if (os.platform() === 'win32') {
  module.exports.lib = path.join(__dirname, `SqreenLibrary-${LIB_VERSION}-Windows-AMD64`, 'lib', 'SqreenStatic.lib')
}
if (os.platform() === 'linux') {
  if (family === GLIBC) {
    module.exports.lib = path.join(__dirname, `SqreenLibrary-${LIB_VERSION}-Linux-x86_64-glibc`, 'lib', 'libsqreen.a')
  }
  if (family === MUSL) {
    module.exports.lib = path.join(__dirname, `SqreenLibrary-${LIB_VERSION}-Linux-x86_64-muslc`, 'lib', 'libsqreen.a')
  }
}
