'use strict'
const { expect } = require('chai')
const { extractSigned } = require('../src/extraction')

describe('TUF', () => {
  describe('extractions', () => {
    it('should work on complex payloads', () => {
      const res = extractSigned(`{"signed":{"hello":{"world":"{\\""}}}`) // FIXME: the string parts MUST be detected with JSON.parse
      expect(res).to.equal(`{"hello":{"world":"{\\""}}`)
    })
    it('should work on simple payloads', () => {
      expect(extractSigned(`{"signed":{}}`)).to.equal(`{}`)
      // eslint-disable-next-line max-len
      const longEntry = `{"signatures":[{"keyid":"5c4ece41241a1bb513f6e3e5df74ab7d5183dfffbd71bfd43127920d880569fd","sig":"d212058b75acd994d925e8312aeff098c8cf187f765b1a8ab4942ac05e7489f95bdfe96660fbb4a68c5c0b8f251124dddd0ac5ef85082d1871f2a5c758151f0a"}],"signed":{"_type":"targets","custom":{"opaque_backend_state":"eyJ2ZXJzaW9uIjoxLCJzdGF0ZSI6eyJmaWxlX2hhc2hlcyI6WyJNZTdnaUNVU2RFMXQxdyt1SndYL3FsNlhKY0wxZ1pHWDlQaytDUkVWMUxjPSIsImdnUG9zVEo1dExMUzdaNk83dHYyWnNFNnEyN25xTkRscjVuV1pxUzc0R0E9IiwiV1BzRXpZY0NSSzI5WHFRYlo2blJSdllwcloxQUFuYjRPbTdXQlFnZjYxWT0iXX19"},"expires":"2022-11-18T13:20:39Z","spec_version":"1.0.0","targets":{"datadog/2/APM_SAMPLING/dynamic_rates/config":{"custom":{"v":40614},"hashes":{"sha256":"58fb04cd870244adbd5ea41b67a9d146f629ad9d400276f83a6ed605081feb56"},"length":68393},"datadog/2/ASM/asm_configuration/config":{"custom":{"v":201},"hashes":{"sha256":"31eee0882512744d6dd70fae2705ffaa5e9725c2f5819197f4f93e091115d4b7"},"length":311},"employee/ASM_DD/2.recommended.json/config":{"custom":{"v":1},"hashes":{"sha256":"8203e8b13279b4b2d2ed9e8eeedbf666c13aab6ee7a8d0e5af99d666a4bbe060"},"length":174015}},"version":28696077}}`
      // eslint-disable-next-line max-len
      const longOutput = `{"_type":"targets","custom":{"opaque_backend_state":"eyJ2ZXJzaW9uIjoxLCJzdGF0ZSI6eyJmaWxlX2hhc2hlcyI6WyJNZTdnaUNVU2RFMXQxdyt1SndYL3FsNlhKY0wxZ1pHWDlQaytDUkVWMUxjPSIsImdnUG9zVEo1dExMUzdaNk83dHYyWnNFNnEyN25xTkRscjVuV1pxUzc0R0E9IiwiV1BzRXpZY0NSSzI5WHFRYlo2blJSdllwcloxQUFuYjRPbTdXQlFnZjYxWT0iXX19"},"expires":"2022-11-18T13:20:39Z","spec_version":"1.0.0","targets":{"datadog/2/APM_SAMPLING/dynamic_rates/config":{"custom":{"v":40614},"hashes":{"sha256":"58fb04cd870244adbd5ea41b67a9d146f629ad9d400276f83a6ed605081feb56"},"length":68393},"datadog/2/ASM/asm_configuration/config":{"custom":{"v":201},"hashes":{"sha256":"31eee0882512744d6dd70fae2705ffaa5e9725c2f5819197f4f93e091115d4b7"},"length":311},"employee/ASM_DD/2.recommended.json/config":{"custom":{"v":1},"hashes":{"sha256":"8203e8b13279b4b2d2ed9e8eeedbf666c13aab6ee7a8d0e5af99d666a4bbe060"},"length":174015}},"version":28696077}`
      expect(extractSigned(longEntry)).to.equal(longOutput)
    })
  })
})
