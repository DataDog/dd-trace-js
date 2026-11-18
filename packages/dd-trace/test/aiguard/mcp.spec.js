'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

const { describe, it } = require('mocha')

const { createClientServer } = require('../../src/aiguard/mcp')

/** @typedef {import('../../src/aiguard/mcp').TransportInfo} TransportInfo */

/**
 * The server ID rule of the wire contract, computed without the tracer.
 *
 * @param {string} key
 */
function serverId (key) {
  return 'mcp_' + createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
}

describe('AI Guard MCP helpers', () => {
  describe('URL origin of a remote server', () => {
    for (const [url, expected] of [
      ['https://mcp.example.com/mcp', 'https://mcp.example.com'],
      ['HTTPS://MCP.Example.COM:443/Mcp/', 'https://mcp.example.com'],
      ['http://mcp.example.com:80/sse', 'http://mcp.example.com'],
      ['http://mcp.example.com:8080/sse', 'http://mcp.example.com:8080'],
      ['https://user:secret@mcp.example.com/mcp?token=abc#frag', 'https://mcp.example.com'],
      ['https://mcp.example.com/api/mcp/s/s3cr3t-t0ken/mcp', 'https://mcp.example.com'],
      ['https://mcp.example.com/mcp;params?q=1', 'https://mcp.example.com'],
      ['http://[::1]:9000/mcp', 'http://[::1]:9000'],
      ['https://mcp.example.com', 'https://mcp.example.com'],
      ['https://mcp.example.com:notaport/mcp', undefined],
      ['/relative/path', undefined],
      ['not a url', undefined],
      ['', undefined],
      ['ws://MCP.Example.com:80/ws?token=abc', 'ws://mcp.example.com'],
      ['ws://mcp.example.com:8080/ws', 'ws://mcp.example.com:8080'],
      ['wss://user:secret@mcp.example.com:443/ws', 'wss://mcp.example.com'],
      ['wss://mcp.example.com:8443/ws', 'wss://mcp.example.com:8443'],
      // A default port of another scheme is not dropped.
      ['http://mcp.example.com:443/mcp', 'http://mcp.example.com:443'],
      // Other schemes keep their port, and their host is lowercased too.
      ['custom://User@MCP.Example.com:7000/path', 'custom://mcp.example.com:7000'],
      ['file:///tmp/server.sock', undefined],
      // An IPv4 literal keeps the canonical dotted-quad form of the parser.
      ['http://2130706433/mcp', 'http://127.0.0.1'],
      ['http://0x7f.1/mcp', 'http://127.0.0.1'],
      ['http://127.1/mcp', 'http://127.0.0.1'],
      ['http://127.0.0.1:8080/mcp', 'http://127.0.0.1:8080'],
      // An IPv6 literal keeps the canonical compressed form in brackets.
      ['http://[0:0::1]:9000/mcp', 'http://[::1]:9000'],
      // A host with an IDN label gets no origin, also in Unicode or percent-encoded form.
      ['http://bücher.example/mcp', undefined],
      ['http://xn--bcher-kva.example/mcp', undefined],
      ['http://MCP.XN--BCHER-KVA.example/mcp', undefined],
      ['http://b%C3%BCcher.example/mcp', undefined],
      ['http://mcp.example.xn--p1ai/mcp', undefined],
      // Only a label that starts with xn-- is an IDN label.
      ['http://axn--b.example/mcp', 'http://axn--b.example'],
      // The parser decodes percent-encoded ASCII in a host.
      ['http://%65xample.com/mcp', 'http://example.com'],
      ['http://my_server.example/mcp', 'http://my_server.example'],
    ]) {
      it(`keeps ${expected} of ${JSON.stringify(url)}`, () => {
        const server = createClientServer({ type: 'streamable_http', url })

        if (expected === undefined) {
          assert.strictEqual(server, undefined)
        } else {
          assert.deepStrictEqual(server, {
            id: serverId(`url|${expected}`),
            managed_by: 'client',
            transport: 'streamable_http',
            url: expected,
          })
        }
      })
    }

    it('reads the URL object that the SDK keeps', () => {
      const server = createClientServer({ type: 'sse', url: new URL('https://user:secret@MCP.example.com/sse?t=1') })

      assert.strictEqual(server?.url, 'https://mcp.example.com')
    })

    it('reads no origin from a URL object with a Unicode host, and uses the next key', () => {
      const url = new URL('http://bücher.example/mcp')

      assert.strictEqual(createClientServer({ type: 'streamable_http', url }), undefined)
      assert.deepStrictEqual(createClientServer({ type: 'streamable_http', url }, 'atlassian'), {
        id: 'mcp_4b1df2a2d821278c',
        managed_by: 'client',
        name: 'atlassian',
        transport: 'streamable_http',
      })
      // A stdio transport uses its command, and never a URL.
      const stdio = /** @type {TransportInfo} */ ({ type: 'stdio', command: 'uvx', args: ['mcp-example'], url })
      assert.strictEqual(createClientServer(stdio)?.id, 'mcp_0f2f11f8cafdbcc5')
    })

    it('reports a WebSocket server as an unknown transport with its URL origin', () => {
      const server = createClientServer({ type: 'websocket', url: 'wss://mcp.example.com/ws?token=abc' })

      assert.deepStrictEqual(server, {
        id: serverId('url|wss://mcp.example.com'),
        managed_by: 'client',
        transport: 'unknown',
        url: 'wss://mcp.example.com',
      })
    })
  })

  describe('server ID', () => {
    it('matches the cross-tracer vectors', () => {
      assert.strictEqual(createClientServer({ type: 'sse', url: 'https://mcp.example.com' })?.id, 'mcp_b77bc22583ac5006')
      assert.strictEqual(
        createClientServer({ type: 'stdio', command: 'uvx', args: ['mcp-example'] })?.id,
        'mcp_0f2f11f8cafdbcc5'
      )
      assert.strictEqual(createClientServer({ type: 'in_process' }, 'atlassian')?.id, 'mcp_4b1df2a2d821278c')
    })

    it('matches the cross-tracer vectors of IP literals and decoded hosts', () => {
      for (const [url, id] of [
        ['http://2130706433/mcp', 'mcp_bb3842ff8c77d25d'],
        ['http://0x7f.1/mcp', 'mcp_bb3842ff8c77d25d'],
        ['http://127.1/mcp', 'mcp_bb3842ff8c77d25d'],
        ['http://127.0.0.1:8080/mcp', 'mcp_b339e608ea2ddcc1'],
        ['http://[0:0::1]:9000/mcp', 'mcp_cc35033de8004f7e'],
        ['http://%65xample.com/mcp', 'mcp_35da95b0ebe35a00'],
        ['http://my_server.example/mcp', 'mcp_2607363cabc2eebc'],
      ]) {
        assert.strictEqual(createClientServer({ type: 'streamable_http', url })?.id, id, url)
      }
    })

    it('uses the first key that applies', () => {
      const byUrl = createClientServer({ type: 'streamable_http', url: 'https://mcp.example.com/mcp' }, 'atlassian')
      const byCommand = createClientServer({ type: 'stdio', command: 'uvx', args: ['mcp-example'] }, 'atlassian')

      assert.strictEqual(byUrl?.id, 'mcp_b77bc22583ac5006')
      assert.strictEqual(byCommand?.id, 'mcp_0f2f11f8cafdbcc5')
    })
  })

  describe('stdio arguments', () => {
    for (const [command, args, expected] of /** @type {Array<[string, unknown, string[]]>} */ ([
      ['npx', ['-y', '@scope/pkg@1.2.3', '--api-key', 'secret'], ['@scope/pkg@1.2.3']],
      ['npx', ['--yes', '-q', 'mcp-server-fetch'], ['mcp-server-fetch']],
      ['/usr/local/bin/NPX.CMD', ['--quiet', 'pkg'], ['pkg']],
      ['bunx', ['pkg@latest'], ['pkg@latest']],
      ['pnpx', ['@modelcontextprotocol/server-everything'], ['@modelcontextprotocol/server-everything']],
      ['uvx', ['mcp-example', '--token', 'secret'], ['mcp-example']],
      ['uvx.exe', ['mcp-example'], ['mcp-example']],
      ['python', ['-m', 'mcp_server.main', '--token', 'secret'], ['mcp_server.main']],
      ['python3', ['-m', 'mcp_server'], ['mcp_server']],
      ['/usr/bin/python3.12', ['-m', 'pkg.module'], ['pkg.module']],
      // The first argument that is not a flag must be a package, or no argument is safe.
      ['npx', ['-y', './local/server.js'], []],
      ['npx', ['--registry', 'https://user:token@registry.example.com', 'pkg'], []],
      ['npx', ['-y', 'https://example.com/pkg.tgz'], []],
      ['npx', ['-y'], []],
      ['npx', ['-y', 42], []],
      ['python', ['-m', 'bad-module'], []],
      ['python', ['server.py', '--token', 'secret'], []],
      ['python', ['-m'], []],
      ['pythonw', ['-m', 'mcp_server'], []],
      ['node', ['server.js', '--token', 'secret'], []],
      ['docker', ['run', '-e', 'TOKEN=secret', 'image'], []],
      ['npx', 'not-an-array', []],
    ])) {
      it(`keeps ${JSON.stringify(expected)} of ${command} ${JSON.stringify(args)}`, () => {
        const server = createClientServer({ type: 'stdio', command, args })

        assert.deepStrictEqual(server, {
          id: serverId(['stdio', command, ...expected].join('|')),
          managed_by: 'client',
          transport: 'stdio',
          command,
          ...(expected.length > 0 ? { args: expected } : {}),
        })
      })
    }
  })

  describe('server entry', () => {
    it('uses the configured name when no URL or command identifies the server', () => {
      assert.deepStrictEqual(createClientServer({ type: 'in_process' }, 'atlassian'), {
        id: 'mcp_4b1df2a2d821278c',
        managed_by: 'client',
        name: 'atlassian',
        transport: 'in_process',
      })
    })

    for (const [description, info] of /** @type {Array<[string, TransportInfo|undefined]>} */ ([
      ['an in-process transport', { type: 'in_process' }],
      ['a custom transport', { type: 'unknown' }],
      ['a remote transport without a URL', { type: 'sse' }],
      ['a remote transport with a relative URL', { type: 'streamable_http', url: '/mcp' }],
      ['a stdio transport without a command', { type: 'stdio', args: ['-y', 'pkg'] }],
      ['a missing transport', undefined],
    ])) {
      it(`has no entry for ${description}`, () => {
        assert.strictEqual(createClientServer(info), undefined)
      })
    }
  })
})
