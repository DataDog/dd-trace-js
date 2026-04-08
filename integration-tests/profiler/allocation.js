'use strict'

require('dd-trace').init()

// Retain objects so they appear in both alloc and inuse
const retained = []
for (let i = 0; i < 5000; i++) {
  retained.push({ i, data: new Array(10) })
}

// Throwaway objects (alloc only, will be GC'd)
for (let i = 0; i < 5000; i++) {
  void { i, data: new Array(10) }
}

// Wait for profiler flush, keep retained alive
setTimeout(() => {
  process.stdout.write(String(retained.length))
}, Number(process.env.TEST_DURATION_MS ?? 5000))
