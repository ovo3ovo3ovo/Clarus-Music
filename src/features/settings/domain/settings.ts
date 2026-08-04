export type AppLocale = 'auto' | 'zh-CN' | 'zh-TW' | 'en' | 'tr'
export type AppTheme = 'oled' | 'light'
export type MusicQuality = '128000' | '192000' | '320000' | 'flac' | '999000'
export type LyricFontSize = 36 | 44 | 52 | 60
export type LyricsBackground = 'off' | 'cover' | 'blur' | 'dynamic'
export type CloseAppOption = 'ask' | 'exit' | 'minimizeToTray'
export type ProxyProtocol = 'noProxy' | 'http' | 'https' | 'socks5'

export interface ProxyConfig {
  readonly protocol: ProxyProtocol
  readonly server: string
  readonly port: number | null
}

export interface Shortcut {
  readonly id: string
  readonly name: string
  readonly shortcut: string
  readonly globalShortcut: string
}

export interface AppSettings {
  readonly schemaVersion: number
  readonly locale: AppLocale
  readonly appearance: AppTheme
  readonly musicQuality: MusicQuality
  readonly lyricFontSize: LyricFontSize
  readonly outputDevice: string
  readonly enableUnblockNeteaseMusic: boolean
  readonly automaticallyCacheSongs: boolean
  readonly cacheLimitMb: number | null
  readonly showLyricsTranslation: boolean
  readonly lyricsBackground: LyricsBackground
  readonly closeAppOption: CloseAppOption
  readonly enableGlobalShortcut: boolean
  readonly proxy: ProxyConfig
  readonly enableRealIp: boolean
  readonly realIp: string | null
  readonly shortcuts: readonly Shortcut[]
  readonly unblockSources: readonly string[]
  readonly unblockSearchMode: 'fast-first' | 'order-first'
  readonly unblockEnableFlac: boolean
  readonly unblockProxyUri: string | null
  readonly unblockYtdlExecutable: string | null
}

export const defaultShortcuts: readonly Shortcut[] = [
  {
    id: 'play',
    name: '播放/暂停',
    shortcut: 'CommandOrControl+P',
    globalShortcut: 'Alt+CommandOrControl+P',
  },
  {
    id: 'next',
    name: '下一首',
    shortcut: 'CommandOrControl+Right',
    globalShortcut: 'Alt+CommandOrControl+Right',
  },
  {
    id: 'previous',
    name: '上一首',
    shortcut: 'CommandOrControl+Left',
    globalShortcut: 'Alt+CommandOrControl+Left',
  },
  {
    id: 'increaseVolume',
    name: '增加音量',
    shortcut: 'CommandOrControl+Up',
    globalShortcut: 'Alt+CommandOrControl+Up',
  },
  {
    id: 'decreaseVolume',
    name: '减少音量',
    shortcut: 'CommandOrControl+Down',
    globalShortcut: 'Alt+CommandOrControl+Down',
  },
  {
    id: 'like',
    name: '喜欢歌曲',
    shortcut: 'CommandOrControl+L',
    globalShortcut: 'Alt+CommandOrControl+L',
  },
  {
    id: 'minimize',
    name: '隐藏/显示播放器',
    shortcut: 'Alt+Shift+CommandOrControl+M',
    globalShortcut: 'Alt+Shift+CommandOrControl+M',
  },
]

export const defaultSettings: AppSettings = {
  schemaVersion: 1,
  locale: 'auto',
  appearance: 'light',
  musicQuality: '320000',
  lyricFontSize: 36,
  outputDevice: 'default',
  enableUnblockNeteaseMusic: true,
  automaticallyCacheSongs: true,
  cacheLimitMb: 8192,
  showLyricsTranslation: true,
  lyricsBackground: 'cover',
  closeAppOption: 'ask',
  enableGlobalShortcut: true,
  proxy: { protocol: 'noProxy', server: '', port: null },
  enableRealIp: false,
  realIp: null,
  shortcuts: defaultShortcuts,
  unblockSources: [],
  unblockSearchMode: 'fast-first',
  unblockEnableFlac: false,
  unblockProxyUri: null,
  unblockYtdlExecutable: null,
}

export function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    proxy: { ...settings.proxy },
    shortcuts: settings.shortcuts.map((shortcut) => ({ ...shortcut })),
    unblockSources: [...settings.unblockSources],
  }
}
