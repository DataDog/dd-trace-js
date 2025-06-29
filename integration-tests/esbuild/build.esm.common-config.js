const ddPlugin = require('../../esbuild')
module.exports = {
  format: 'esm',
  entryPoints: ['basic-test.js'],
  bundle: true,
  outfile: 'out.mjs',
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node18'],
  external: [
    // dead code paths introduced by knex
    'pg',
    'mysql2',
    'better-sqlite3',
    'sqlite3',
    'mysql',
    'oracledb',
    'pg-query-stream',
    'tedious'
  ]
}
