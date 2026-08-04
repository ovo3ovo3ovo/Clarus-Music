import { describe, expect, it } from 'vitest'
import { validateProxyDraft, validateRealIpDraft } from './settings-form'

describe('settings form validation', () => {
  it('normalizes a complete proxy draft', () => {
    expect(
      validateProxyDraft({ protocol: 'socks5', server: ' 2001:db8::1 ', port: '1080' }),
    ).toEqual({
      ok: true,
      value: { protocol: 'socks5', server: '2001:db8::1', port: 1080 },
    })
  })

  it('does not accept partial or ambiguous proxy configuration', () => {
    expect(validateProxyDraft({ protocol: 'http', server: '', port: '8080' })).toEqual({
      ok: false,
      field: 'server',
    })
    expect(
      validateProxyDraft({ protocol: 'https', server: 'https://proxy.test', port: '8080' }),
    ).toEqual({ ok: false, field: 'server' })
    expect(validateProxyDraft({ protocol: 'http', server: 'proxy.test', port: '65536' })).toEqual({
      ok: false,
      field: 'port',
    })
  })

  it('allows disabling a proxy without discarding a valid draft', () => {
    expect(validateProxyDraft({ protocol: 'noProxy', server: 'proxy.test', port: '8080' })).toEqual(
      {
        ok: true,
        value: { protocol: 'noProxy', server: 'proxy.test', port: 8080 },
      },
    )
  })

  it('accepts canonical IPv4 and IPv6 but rejects hostnames and malformed addresses', () => {
    expect(validateRealIpDraft('203.0.113.8')).toEqual({ ok: true, value: '203.0.113.8' })
    expect(validateRealIpDraft('2001:db8::8')).toEqual({ ok: true, value: '2001:db8::8' })
    expect(validateRealIpDraft('example.test')).toEqual({ ok: false, field: 'realIp' })
    expect(validateRealIpDraft('999.1.1.1')).toEqual({ ok: false, field: 'realIp' })
  })
})
