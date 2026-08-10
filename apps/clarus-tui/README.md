# Clarus Music TUI

Clarus Music 的纯文字、键盘优先网易云音乐终端客户端。它只提供每日推荐、我最喜欢、收藏的歌单和创建的歌单；不包含搜索、图片、艺人/专辑页、MV 或歌单写操作。

## 运行

```sh
cargo run -p clarus-tui
```

如果你明确希望跳过本次 Keychain 恢复（例如系统授权 sheet 正在等待决定），可以直接进入二维码登录：

```sh
cargo run -p clarus-tui -- --qr-login
```

启动时先从系统 Keychain 恢复登录态。Keychain 的系统授权 sheet 不能安全地按时间强行取消，因此 TUI 不再把它伪装成可重试的 5 秒超时：同一运行只会尝试一次自动恢复，所有 Clarus 进程还共享一个非阻塞锁，确保任何时刻最多一个系统授权调用。若它正在等待、被拒绝或失败，按 `r`、`Enter` 或 `Esc` 会直接进入二维码登录，不会再触发 Keychain。二维码服务端授权后，cookie 会先留在 Rust core；若 Keychain 写入失败，应用仍可在本次运行中登录，并明确提示该登录态不会持久保存。没有登录态时，二维码直接由终端单元格绘制；面板显示约 180 秒有效期，过期后按 `r` 重新生成，`Esc` 取消本轮登录。应用日志不写入 alternate screen；非 TTY 环境会退化为简短 CLI 提示。

核心按键：`Space` 播放/暂停、`n`/`p` 切歌、方向键 ±5 秒、`Shift+方向键` ±30 秒、`[`/`]` 备用 seek、`-`/`=` 调音量、`v` 切换歌词、`Ctrl+X` 退出（`Ctrl+Q` 为兼容别名；普通 `q` 不退出）。列表、播放器和歌词不响应普通鼠标点击；滚轮/触控板滚动按行限速，宽屏分隔线可以拖动调整。TUI 只开启滚轮和分隔线拖动所需的 SGR 鼠标报告，不开启全鼠标移动报告。`Tab` 只在左侧导航、歌曲/歌单列表和播放器之间循环，不会把焦点放入歌词。账号默认的“我喜欢的音乐”歌单不会重复出现在“创建的歌单”中。

如果登录态在使用中失效，无权限状态会保留明确的错误说明；按 `Esc` 可直接进入二维码重新认证，按 `r` 只重试当前请求。

三栏布局只在有当前歌曲且终端足够宽时启用；播放前不会为歌词占用空 pane，较窄窗口会把歌词切换为主 pane。文件打开、解码器构造和音频设备初始化在 blocking worker 中完成，切歌时由 cancellation token 和 playback generation 丢弃旧结果。音频准备阶段还有单一串行闸门；旧 generation 即使已经进入 blocking worker，也不能与新歌曲并发打开第二个解码器。窄屏进入歌词单 pane 时，焦点会自动移到仍可见的播放器，不会留在隐藏的歌曲列表上。

## 结构

```text
clarus-core  → 网易云请求、Keychain、分页模型、歌词时间轴、队列、受控音频缓存
clarus-tui   → ratatui/crossterm 状态机、终端渲染、输入路由、原生音频 owner
```

`clarus-tui` 直接调用 `clarus-core`，不经过 Tauri IPC。所有网络、Keychain、歌词、流媒体解析和缓存请求都有 task abort、协作取消 token 与 generation 检查；旧请求不能覆盖新页面或新歌曲。队列由 core 保留服务返回顺序，UI 只负责展示和触发动作。

## 视觉与终端兼容

绘制区域使用黑底和白色主文字，反色表示当前键盘焦点，暗灰表示次要信息；颜色不是唯一语义。没有 true color 时分隔线和歌词动画会降级；设置 `CLARUS_TUI_ASCII=1` 可强制测试 ASCII 二维码、进度条和列表标记。歌词只显示原文，按右侧 pane 的实际 display width 换行，绝不使用省略号裁切歌词；80×24 时采用单 pane 降级策略。

动画只在歌词行切换的短过渡期间唤醒；支持 true-color 的终端目标上限为 120Hz，ANSI / capability-limited 终端降为 20Hz 的状态过渡，避免重绘不可表达的插值帧。播放稳定后进度和歌词按必要事件刷新，不维持全屏 120fps 重绘。

## 音频后端验证

音频经 `clarus-core` 的受控磁盘缓存后由单一原生 Rust 播放器解码。可用本地音频文件运行基准，并在相同机器/输出设备上比较 native 与 mpv 的总 CPU/RSS：

```sh
cargo run -p clarus-tui -- --benchmark-audio /path/to/audio.mp3 20
```

第二个参数是采样秒数，范围为 3–1800；基准专用播放路径会循环音频，mpv 也使用无限循环，因此传 `1800` 才能执行完整 30 分钟稳定播放观察。报告包含启动耗时、采样平均 CPU、峰值与首尾 RSS 差、以及线程数首尾快照；mpv 数字包含 clarus-tui 与 mpv 子进程。线程快照只用于发现明显增长，任务/定时器和 alternate screen 输出量仍应在完整 TUI 长时运行中记录。若系统没有 `mpv` 会明确跳过。完成同机基准前，不把 native 或 mpv 宣称为最终后端；当前垂直切片默认使用 native rodio。

## 验证

```sh
cargo fmt --check
cargo test -p clarus-core -p clarus-tui
cargo clippy -p clarus-core -p clarus-tui --all-targets -- -D warnings
cargo build --release -p clarus-tui
```

真实账号 QR 登录、每日推荐、流媒体播放、Terminal.app/iTerm2/Kitty 实测，以及 30 分钟 RSS/CPU 基线仍需在目标机器上执行；代码不会伪造这些运行数据。
