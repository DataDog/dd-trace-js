'use strict'

// https://en.wikipedia.org/wiki/ANSI_escape_code#Colors
module.exports = {
  GRAY: String.raw`\033[1;90m`,
  CYAN: String.raw`\033[1;36m`,
  NONE: String.raw`\033[0m`,
}
