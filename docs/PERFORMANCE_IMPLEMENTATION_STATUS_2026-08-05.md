# 性能报告实施状态

本文是 `/Users/oo/Clarus Music/docs/TECHNICAL_PERFORMANCE_AUDIT_2026-08-04.md` 的实施交接记录，不替代原始审计报告。记录只包含当前主分支已落地或明确暂缓的内容。

## 已完成并验证

| 报告任务 | 当前实现 | 证据 |
| --- | --- | --- |
| Task 1 | cache hit 优先返回 `managed-url`，lease 延迟到 Howler source replacement/unload/dispose；bytes 保留为 fallback | `native-audio-cache.ts`、`howler-audio-engine.ts` 测试；`69cd7b1` |
| Task 3 | `AppShell` 用 `v-if` 卸载 LyricsOverlay；scroll anchor 提升到 store；关闭时取消请求/计时器/帧订阅 | `AppShell.vue`、`lyrics-store.ts`、`LyricsOverlay.vue`；`24a741c`、`280c0ca`、`098d864` |
| Task 4（部分） | far lyric 行不再长期设置 `will-change`；active/near 行保留原有 opacity/filter 输出 | `LyricsOverlay.vue` CSS；无原生 GPU A/B，不宣称收益 |
| Task 5 | player progress 与 lyrics 使用共享 scheduler；一帧只读取一次 engine clock；manual focus 使用缓存中心和二分查找 | `playback-frame-scheduler.ts`、`LyricsOverlay.vue`；`eae07c5` 及后续 scheduler lease 修复 |
| Task 5 follow-up | scheduler 订阅者绑定所属 player clock；相同 clock 每帧只采样一次，不同 player 不再串时钟；释放旧 lease 立即移除其闭包；Pinia 通过 raw clock object 共享同一函数身份 | `playback-frame-scheduler.ts`、`player-store.ts`、`LyricsOverlay.vue`、player-store clock identity test |
| Task 6 | Rust access timestamp 内存合并写，按命中数/时间窗口刷 index；写失败不让 resident index 超前 | `audio_cache.rs` 测试；`6a49bf9` |
| Task 7 | queue structure 与 playback state 分离持久化；marker、旧格式迁移、回滚 generation、legacy shadow 与 fingerprint | `queue-snapshot.ts` 测试；`185e663`、`a254b1e`、`5f4c5b3` |
| Task 8（LRU 子任务） | route scroll store 固定 256 条并刷新最近访问顺序；加入 1,000 fullPath 压力契约 | `route-scroll.ts`、`route-scroll.test.ts` |
| Task 9 | 所有当前 Howler source 都使用 `html5:true`，适配器初始化前关闭无用 global WebAudio path | `howler-audio-engine.ts` 测试；`b7b0be1` |
| Task 13 | cover speculative preload 并发 4、pending 32；完成/error/15 秒 timeout 都释放；有界 LRU；队列满时不永久记忆丢弃 URL | `cover-image.ts`、`cover-image.test.ts`；`eae07c5` |
| Task 0（工具子集） | 固定五类 fixture 已存在；新增 scenario manifest、fixture role/运行次数/自动化可用性校验 | `scripts/perf/scenarios/scenario-manifest.json`、`.mjs`、`.test.mjs` |

## 明确未完成/暂缓

### 需要真实原生窗口或授权采样

- startup 冷启动 10 次；目前 external sampler 只附着已运行 release app，并拒绝 `scenarioClass: startup`。
- animation、audio、combined、60 分钟 soak、30-cycle lifecycle 的 macOS UI 操作、视频/截图、GPU/IOSurface、listener/heap/AudioContext 计数。
- 当前设备曾出现 LaunchServices executable attribution mismatch，失败目录不能作为性能证据。

### 需要先有测量再决定的中等/激进方案

- 单一 `HTMLAudioElement` 替换 Howler：当前保留 Howler 对照，未切默认；缺完整原生音频矩阵。
- measured lyric windowing：没有视觉 golden、动态高度/滚动轨迹和 GPU footprint A/B，暂不改变 live DOM 结构。
- SQLite/WAL cache index：已有 JSON 合并写；没有 1k/10k/50k benchmark 和故障注入证据，不先引入依赖。
- HTTP/TLS 依赖统一、AVFoundation/native UI slice：报告定义为低优先级/激进 gate，当前没有证明收益的 profile。

### 文档同步限制

原始 `docs/PERFORMANCE.md`、`docs/ARCHITECTURE.md`、`docs/FEATURE_PARITY.md` 位于主仓库未提交/被忽略的用户文档中；本实施提交不覆盖它们。此文件记录当前真实实现；若后续允许修改这些文档，应同步修正文档中关于 lyrics visibility、runtime blur 和 Howler AudioContext 的漂移描述。

## 当前验证

以下命令在本 worktree 执行并通过（原生场景除外）：

```text
npm run check
npm run perf:test
npm run build
npm run tauri:build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
```

这些结果证明类型、lint、单元契约、fixture/sampler tooling 和 release 构建完整；不证明内存已经降低 50%，也不替代原生播放/动画/长时采样。
