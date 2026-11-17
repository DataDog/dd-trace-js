// Both preload formats share the CommonJS implementation so hook registration
// also works when the runtime disables require(esm).
export { iitmExclusionRegExp, initialize, load, registerSyncLoaderHooks, resolve } from './loader-hook.js'
