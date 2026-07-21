'use strict'

const h3Module = {
  // h3 v2 ships the `H3` and `H3Core` classes in `dist/h3.mjs`. The version
  // range is prerelease inclusive (`-0`) because h3 v2 is still published as
  // release candidates (e.g. `2.0.1-rc.22`), which a plain `*`/`>=2` range
  // would exclude.
  name: 'h3',
  versionRange: '>=2.0.0-0 <3',
  filePath: 'dist/h3.mjs',
}

module.exports = [
  {
    module: h3Module,
    functionQuery: {
      methodName: 'constructor',
      className: 'H3',
      kind: 'Sync',
    },
    channelName: 'H3_constructor',
  },
  {
    module: h3Module,
    functionQuery: {
      methodName: 'constructor',
      className: 'H3Core',
      kind: 'Sync',
    },
    channelName: 'H3Core_constructor',
  },
]
