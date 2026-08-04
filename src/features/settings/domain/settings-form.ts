import type { ProxyConfig, ProxyProtocol } from './settings'

export interface ProxyDraft {
  readonly protocol: ProxyProtocol
  readonly server: string
  readonly port: string
}

export type ValidationResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; field: 'server' | 'port' | 'realIp' }>

export function validateProxyDraft(draft: ProxyDraft): ValidationResult<ProxyConfig> {
  const server = draft.server.trim()
  if (draft.protocol === 'noProxy') {
    return {
      ok: true,
      value: {
        protocol: 'noProxy',
        server,
        port: parseOptionalPort(draft.port),
      },
    }
  }
  if (server.length === 0 || /\s|:\/\//u.test(server)) {
    return { ok: false, field: 'server' }
  }
  const port = Number(draft.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, field: 'port' }
  }
  return { ok: true, value: { protocol: draft.protocol, server, port } }
}

export function validateRealIpDraft(value: string): ValidationResult<string> {
  const realIp = value.trim()
  if (isIpv4(realIp) || isIpv6(realIp)) return { ok: true, value: realIp }
  return { ok: false, field: 'realIp' }
}

function parseOptionalPort(value: string): number | null {
  if (value.trim().length === 0) return null
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null
}

function isIpv4(value: string): boolean {
  const octets = value.split('.')
  return (
    octets.length === 4 &&
    octets.every(
      (octet) =>
        /^\d{1,3}$/u.test(octet) && Number(octet) <= 255 && String(Number(octet)) === octet,
    )
  )
}

function isIpv6(value: string): boolean {
  if (!value.includes(':') || value.includes('%') || value.includes('[') || value.includes(']')) {
    return false
  }
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith('[')
  } catch {
    return false
  }
}
