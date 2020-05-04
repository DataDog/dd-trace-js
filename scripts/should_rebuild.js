'use strict'

const { CI, INIT_CWD, PWD } = process.env

// skip for local development, CI, or very old package managers without INIT_CWD
if (CI === 'true' || !INIT_CWD || INIT_CWD.includes(PWD)) {
  process.exit(1)
}
