'use strict'

// Empirical workaround for the bug surfaced by `ws-stress`:
// Node 18's diagnostics_channel.channel(name) returns different Channel
// objects across calls for the same name, and dc-polyfill's WeakSet-keyed
// anti-GC check can't unify them. Memoize by name in dc-polyfill so all
// callers see the same Channel object regardless of what Node returns.
//
// This is a debug patch applied in CI to test whether the by-name memoization
// fixes ws-stress in CI (it does locally). NOT a permanent fix — the proper
// home is dc-polyfill itself.
//
// Idempotent: re-running has no effect after the first application.

const fs = require('fs')
const path = require('path')

const target = path.resolve(__dirname, '..', 'node_modules', 'dc-polyfill', 'patch-garbage-collection-bug.js')
const original = fs.readFileSync(target, 'utf8')

if (original.includes('byName')) {
  console.log('dc-polyfill already patched; nothing to do.')
  process.exit(0)
}

const find = `module.exports = function(unpatched) {
  const dc_channel = unpatched.channel;
  const channels = new WeakSet();

  const dc = { ...unpatched };

  dc.channel = function() {
    const ch = dc_channel.apply(this, arguments);

    if (channels.has(ch)) return ch;`

const replace = `module.exports = function(unpatched) {
  const dc_channel = unpatched.channel;
  const channels = new WeakSet();
  const byName = new Map(); // PATCH: memoize by name; Node's channel(name) can return different Channels for same name

  const dc = { ...unpatched };

  dc.channel = function() {
    const _name = arguments[0];
    if (byName.has(_name)) return byName.get(_name);
    const ch = dc_channel.apply(this, arguments);
    byName.set(_name, ch);

    if (channels.has(ch)) return ch;`

if (!original.includes(find)) {
  console.error('dc-polyfill source did not match expected shape; aborting patch.')
  console.error('Expected to find:')
  console.error(find)
  process.exit(1)
}

fs.writeFileSync(target, original.replace(find, replace))
console.log('dc-polyfill patched: dc.channel(name) memoized by name.')
