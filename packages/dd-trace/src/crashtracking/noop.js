'use strict'

class NoopCrashtracker {
  configure () {}
  start () {}
  withProfilerSerializing (f) {
    return f()
  }
}

module.exports = new NoopCrashtracker()
