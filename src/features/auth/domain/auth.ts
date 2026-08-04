export interface AuthUser {
  readonly userId: number
  readonly nickname: string
  readonly avatarUrl: string
  readonly signature: string
  readonly vipType: number
}

export interface AuthSession {
  readonly authenticated: boolean
  readonly user: AuthUser | null
}

export interface QrLogin {
  readonly key: string
  readonly loginUrl: string
}

export type QrLoginStatus = 'waiting' | 'scanned' | 'authorized' | 'expired'

export interface QrLoginCheck {
  readonly status: QrLoginStatus
  readonly message: string
}

export interface LogoutResult {
  readonly remoteLogoutSucceeded: boolean
}
