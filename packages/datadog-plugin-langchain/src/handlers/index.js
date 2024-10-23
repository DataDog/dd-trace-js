'use strict'

module.exports = {
  chain: () => require('./chain'),
  chat: () => require('./chat'),
  llm: () => require('./llm'),
  default: () => {
    return {
      getStartTags () {},
      getEndTags () {}
    }
  }
}
