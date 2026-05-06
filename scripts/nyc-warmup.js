'use strict'

// Force-require every .js source file matching nyc's include patterns so the
// require hook instruments and writes them to the on-disk cache. Subsequent
// test runs hit the cache instead of paying the per-file instrumentation cost
// during a `before all` hook (whose default 5s timeout is tight on a slow CI
// runner).
//
// nyc's instrumentation hook is CJS-only (it patches Module._compile), so
// .mjs files are never cached regardless of how they are loaded. They are
// also excluded from the walk because on Node 22+ `require('./initialize.mjs')`
// succeeds and triggers the full dd-trace `init()` we are trying to avoid.

if (process.env.NYC_WARMUP_ENABLED === 'false') process.exit(0)

const fs = require('node:fs')
const path = require('node:path')

// Plugin and instrumentation sources frequently throw on require without their
// target module installed (and some packages emit warnings on load). The cache
// is populated before the throw, which is all we need — silence the noise.
process.stderr.write = () => true

const repoRoot = path.resolve(__dirname, '..')

function tryRequire (file) {
  try { require(file) } catch {}
}

function walk (dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.isFile() && entry.name.endsWith('.js')) tryRequire(full)
  }
}

walk(path.join(repoRoot, 'ext'))

for (const entry of fs.readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const pkg = path.join(repoRoot, 'packages', entry.name)
  walk(path.join(pkg, 'src'))
  for (const f of fs.readdirSync(pkg)) {
    if (f.endsWith('.js')) tryRequire(path.join(pkg, f))
  }
}

// Root entrypoints. `init.js` is intentionally omitted because requiring it
// runs the full dd-trace `init()` and starts background work that delays
// process exit; the source files it would load are walked anyway.
for (const f of ['index.js', 'register.js', 'version.js']) {
  tryRequire(path.join(repoRoot, f))
}
