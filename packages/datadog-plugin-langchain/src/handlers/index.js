'use strict'

module.exports = {
  chain: () => require('./chain'),
  chat_model: () => require('./chat_model'),
  llm: () => require('./llm'),
  default: () => {
    return {
      getStartTags () {},
      getEndTags () {}
    }
  }
}
