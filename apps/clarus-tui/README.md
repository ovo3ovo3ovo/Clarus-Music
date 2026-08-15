# Clarus Music TUI

Clarus Music 的纯文字、键盘优先网易云音乐终端客户端。它只提供每日推荐、我最喜欢、收藏的歌单和创建的歌单；不包含搜索、图片、艺人/专辑页、MV 或歌单写操作。

## 运行

```sh
cargo run -p clarus-tui
```

启动时先从 **TUI 专用的系统 Keychain** 恢复登录态；没有可用会话、恢复失败或会话失效时，会自动进入**二维码登录**。它不与桌面客户端共享 Keychain 条目，因此不会触发跨应用的 macOS 授权框。使用网易云音乐 App 扫描并在手机上确认即可。二维码有效期为 180 秒，`r` 或 `Enter` 重新生成，`Esc` 取消当前二维码，`Ctrl+X` 退出。二维码采用带 4-module quiet zone 的高对比黑白渲染；Unicode 终端优先使用半高块，避免不必要地放大二维码，80×24 时会让二维码优先占用可用屏幕空间。登录成功后 cookie 留在 Rust core 与 TUI 专用 Keychain；若 Keychain 不可用，当前运行仍可使用，并会明确提示不会持久保存。应用日志不写入 alternate screen；非 TTY 环境会退化为简短 CLI 提示。

核心按键：`Space` 播放/暂停、`n`/`p` 切歌、方向键 ±5 秒、`Shift+方向键` ±30 秒、`[`/`]` 备用 seek、`-`/`=` 调音量、`v` 切换歌词、`Ctrl+X` 退出（`Ctrl+Q` 为兼容别名；普通 `q` 不退出）。列表、播放器和歌词不响应普通鼠标点击；滚轮/触控板滚动按行限速，宽屏分隔线可以拖动调整。TUI 只开启滚轮和分隔线拖动所需的 SGR 鼠标报告，不开启全鼠标移动报告。`Tab` 只在左侧导航、歌曲/歌单列表和播放器之间循环，不会把焦点放入歌词。账号默认的“我喜欢的音乐”歌单不会重复出现在“创建的歌单”中。

如果登录态在使用中失效，无权限状态会保留明确的错误说明；按 `Esc` 可直接进入二维码重新认证，按 `r` 只重试当前请求。

三栏布局只在有当前歌曲且终端足够宽时启用；播放前不会为歌词占用空 pane，较窄窗口会把歌词切换为主 pane。文件打开、解码器构造和音频设备初始化在 blocking worker 中完成，切歌时由 cancellation token 和 playback generation 丢弃旧结果。音频准备阶段还有单一串行闸门；旧 generation 即使已经进入 blocking worker，也不能与新歌曲并发打开第二个解码器。窄屏进入歌词单 pane 时，焦点会自动移到仍可见的播放器，不会留在隐藏的歌曲列表上。

## 结构

```text
clarus-core  → 网易云请求、TUI 专用 Keychain 会话、分页模型、歌词时间轴、队列、受控音频缓存
clarus-tui   → ratatui/crossterm 状态机、终端渲染、输入路由、原生音频 owner
```

`clarus-tui` 直接调用 `clarus-core`，不经过 Tauri IPC。所有网络、Keychain、歌词、流媒体解析和缓存请求都有 task abort、协作取消 token 与 generation 检查；旧请求不能覆盖新页面或新歌曲。二维码登录只访问 TUI 专用 Keychain 条目，不会碰桌面客户端的条目。队列由 core 保留服务返回顺序，UI 只负责展示和触发动作。

## 视觉与终端兼容

默认主题为 `--theme auto`。启动时它会在 raw mode、进入 alternate screen 前以最多 90ms 的一次性 OSC 10/11 查询尝试读取终端默认前景/背景色；探测成功后只用结果计算次要文字、分隔线、状态色和歌词过渡，**不会铺应用底色**。普通文字和空白处保留终端自身的默认前景/背景，键盘焦点用反显，因此能自然融入深色、浅色和带透明度的终端 profile。若终端不支持或不回复查询，自动退回同样无底色的 `terminal` 模式：不猜测黑底灰阶 RGB，而使用 reset / ANSI 弱色并降低歌词动画刷新率。

如需明确选择，可以使用 `--theme terminal`（从不查询、始终使用终端原生底色）或 `--theme clarus-black`（保留 Clarus 的纯黑底、白色主文字视觉）。只有左导航、歌词和播放器之间的必要分隔线会被绘制；颜色不是唯一语义。没有 true color 时分隔线和歌词动画会降级；设置 `CLARUS_TUI_ASCII=1` 可强制测试 ASCII 列表标记和进度条。歌词只显示原文，按右侧 pane 的实际 display width 换行，绝不使用省略号裁切歌词；80×24 时采用单 pane 降级策略。

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

真实账号二维码登录、每日推荐、流媒体播放、Terminal.app/iTerm2/Kitty 实测，以及 30 分钟 RSS/CPU 基线仍需在目标机器上执行；代码不会伪造这些运行数据。
