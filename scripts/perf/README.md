# Performance fixture tooling

This is controlled, non-production tooling for repeatable Clarus Music performance measurements. It is never imported, bundled, or served by the production app. It generates only copyright-safe project material: synthesized 16-bit PCM audio and short nonsensical timed YRC tokens. It does not use downloaded media, user data, credentials, artist names, or real lyrics.

The canonical fixture root is the repository’s `artifacts/perf/fixtures`, derived from this tooling’s `import.meta.url` rather than the process working directory. Generated media and locks are ignored by Git under `/artifacts/perf/` and must remain untracked.

## Recipes

The strict canonical manifest is [`fixtures/fixture-recipes.json`](fixtures/fixture-recipes.json). It defines exactly these CC0-1.0, project-generated fixtures at 44,100 Hz stereo:

| Role             | Source duration | Output                                                     |
| ---------------- | --------------: | ---------------------------------------------------------- |
| `tone-short-mp3` |      12 seconds | `audio/mpeg` MP3                                           |
| `tone-long-mp3`  |     300 seconds | `audio/mpeg` MP3                                           |
| `tone-seek-mp3`  |     120 seconds | `audio/mpeg` MP3 with markers at 0, 30, 60, and 90 seconds |
| `tone-flac`      |      30 seconds | `audio/flac` FLAC                                          |
| `word-timed-yrc` |      18 seconds | `text/plain` deterministic YRC                             |

The verifier requires exact YRC bytes and an 18,000 ms timeline. For the seek fixture it decodes real PCM and compares coherent 1760 Hz marker energy at 0/30/60/90 seconds with absent-control windows at 15/45/75/105 seconds. The quietest marker must be at least 10 dB above the loudest control.

## Required local tools

This tooling is macOS-only and never installs or upgrades tools itself. Install the local Homebrew dependency once:

```sh
/opt/homebrew/bin/brew install lame
```

Only Homebrew LAME 4.0 is accepted, at `/opt/homebrew/bin/lame`; its license is LGPL-2.0-or-later. MP3 generation always uses fixed 128 kbps CBR settings:

```text
--cbr -b 128 --noreplaygain
```

FLAC generation and all PCM decoding use only `/usr/bin/afconvert`; metadata inspection uses `/usr/bin/afinfo`. Before any long PCM allocation, generation performs a bounded real MP3 and FLAC encode, `afinfo` identification, and PCM decode. Missing, wrong-version, or nonfunctional tools fail closed.

`fixtures.lock.json` is strict and records the encoder names, normalized exact versions, and fixed settings, plus each file’s relative name, length, and SHA-256. It never records executable or filesystem paths.

## Commands

```sh
npm run perf:test
npm run perf:fixtures:generate -- --output artifacts/perf/fixtures/current
npm run perf:fixtures:verify -- --directory artifacts/perf/fixtures/current
npm run perf:fixtures:serve -- --directory artifacts/perf/fixtures/current
```

The three exact fixture suites are `generate.test.mjs`, `verify.test.mjs`, and `range-server.test.mjs`.

All public output, verify, and serve directories must be strict children of the canonical fixture root. The root itself, outside absolute paths, `..` traversal, and symlinked output directories or components are rejected. Locks and fixture files are opened with no-follow regular-file checks; the loopback server retains those verified handles for its lifetime.

Generation defaults to the `current` child. It refuses an existing target unless `--force` is supplied. A force publish creates and fully verifies a sibling staging set, atomically preserves the old target as a sibling backup, renames the complete directory, then verifies the new target before deleting the backup. The next generation recovers stale staging or backup state after an interrupted transaction. Do not manually edit transaction directories.

The server verifies before listening, exposes only lock-listed filenames, supports GET/HEAD and a single byte range, and binds only to ephemeral `127.0.0.1`. Stop it with `SIGINT` or `SIGTERM` for clean handle shutdown.

## Measurement discipline

Every before/after A/B pair must reuse the exact same fixture directory and its exact `fixtures.lock.json`. Regenerating or changing any locked file invalidates that comparison; start a new pair instead. The sampler retains no-follow identity and timestamp witnesses across numeric phases, so changing and then restoring bytes during a run also makes that run unusable. Run verification immediately before each measurement session.

## External sampler and versioned reports

`perf:sample` is non-production, macOS-only measurement infrastructure. It attaches to one already-running **release** bundle; it never launches, controls, signals, instruments, or imports the Clarus Music product. Its output is not evidence of a product performance improvement.

The only supported bundle is the worktree build at `src-tauri/target/release/bundle/macos/Clarus Music.app`. The bundle must be a real, non-symlink `.app` with bundle identifier `com.ovo3ovo3ovo.clarusmusic`; its executable is read from `Contents/Info.plist` (currently `simplemusic`). Do not point it at an installed `/Applications` copy.

```sh
npm run perf:sample -- \
  --app-bundle "src-tauri/target/release/bundle/macos/Clarus Music.app" \
  --root-pid 12345 \
  --fixture-directory artifacts/perf/fixtures/current \
  --metadata artifacts/perf/metadata/idle-r01.json \
  --output artifacts/perf/runs/idle-r01 \
  --samples 5 \
  --interval-ms 2000 \
  --stack-duration-seconds 5 \
  --stack-interval-ms 1
```

All options are required except `--stack-duration-seconds` (default `0`, which disables stacks) and `--stack-interval-ms` (default `1`). The CLI rejects positional arguments, unknown or duplicate options, `--key=value`, missing values, unsafe output paths, and overwrites. The root PID is a decimal safe integer greater than 1; samples are 5–3600; interval is a whole number of seconds from 1000–60000 ms (macOS `top -s` has integer-second semantics); `samples × interval-ms` is at most 3,600,000 ms; stack duration is 0–60 seconds; stack interval is 1–1000 ms.

The metadata file is opened no-follow, must be a regular JSON file no larger than 16 KiB, and has exactly these controls:

```text
scenario, scenarioClass, runId, runIndex, buildKind, coldWarm, cacheState,
windowCssPx { width, height }, displayScale, powerSource, powerMode, volume,
outputDevice, networkProfile, settingsFixture, queueFixture, fixtureRoles, notes
```

`scenario` and `runId` use `[a-z0-9][a-z0-9._-]{0,63}`. This sampler accepts only `scenarioClass: "runtime"`; `startup` is refused. `fixtureRoles` must be unique and present in the fixture lock verified immediately before sampling. Regenerating or changing the fixture directory during a run makes it unusable.

The sampler creates one new strict child under `artifacts/perf/runs`. A completed v1 report contains `run.json`, RFC 4180 `measurements.csv`, `summary.txt`, and checksummed evidence under `raw/` (metadata, fixture lock, and deterministic stdout/stderr files). `run.json` is committed from an exclusive staging file through an atomic no-replace publish; failed/interrupted reports use the same transaction and an output commit failure may leave no `run.json`. An existing `run.json` not created by the current run is never overwritten. `summary.txt` begins:

```text
MEASUREMENT INFRASTRUCTURE OUTPUT — NOT EVIDENCE OF PRODUCT IMPROVEMENT.
```

Reports use `$schema: "clarus.perf.run"`, schema version `1`, producer `clarus-perf-external-sampler` version `1`. Failed or interrupted runs retain partial raw evidence and a best-effort, explicitly unusable `run.json`; they must not be used for a conclusion.

## Attribution and collection safety

Attribution is deliberately path- and identity-based. The sampler reads `/bin/ps`, `/usr/bin/lsappinfo`, and `/usr/bin/plutil`, verifies the root PID's executable realpath, records PID/PPID/start identity, and requires matching LaunchServices ASN/coalition evidence. It selects exactly one canonical WebKit WebContent, GPU, and Networking XPC helper under `/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices`. Same-name processes, basenames, newest processes, CPU ranking, `pgrep`, and manual PID lists are never used.

Attribution is revalidated before numeric sampling, between `top`, `footprint`, and optional `sample` stacks, and after collection. PID reuse, an executable or coalition change, a missing/duplicate/outside helper, or a fixture drift stops the run. Unknown coalition members are recorded but not sampled.

The sampler's attribution and numeric collection use only these absolute macOS executables: `/bin/ps`, `/usr/bin/lsappinfo`, `/usr/bin/plutil`, `/usr/bin/git`, `/usr/bin/sw_vers`, `/usr/bin/top`, `/usr/bin/footprint`, and `/usr/bin/sample`. Fixture audio verification additionally uses the fixed `/usr/bin/afinfo` and `/usr/bin/afconvert` paths through the same bounded child runner; these children are included in active lifecycle cleanup and are not product processes. Each spawn uses an argv array, `shell: false`, and a minimal C-locale environment. The sampler never installs tools, invokes a shell, requests privileges, weakens permissions, or sends a signal to the app or attributed process.

Numeric phases are sequential: one `top` command takes `samples + 1` snapshots and the warmup snapshot is discarded; then every `footprint --format bytes -p PID` call runs sequentially; optional perturbing stacks run last for main and WebContent and remain raw-only. Per-process footprint peaks are never added together. Missing PIDs, parse drift, truncation, output limits, permission denial, timeout, or a signal stops scheduling and leaves the report unusable.

Exit code `0` means a completed report, `2` is an input/preflight refusal (including an unavailable required sampler tool), `3` is sampling, parsing, permission, target, or fixture drift failure, `130` is `SIGINT`, and `143` is `SIGTERM`.

## Cohort summaries

`perf:summarize` creates a separate descriptive cohort; it does not compare A/B variants or claim an improvement.

```sh
npm run perf:summarize -- \
  --input artifacts/perf/runs/idle-r01/run.json \
  --input artifacts/perf/runs/idle-r02/run.json \
  --input artifacts/perf/runs/idle-r03/run.json \
  --input artifacts/perf/runs/idle-r04/run.json \
  --input artifacts/perf/runs/idle-r05/run.json \
  --output artifacts/perf/summaries/idle-runtime
```

Supply 1–1000 distinct, no-follow regular v1 `run.json` inputs that are strict realpath-contained children of canonical `artifacts/perf/runs`, plus one new strict child of `artifacts/perf/summaries`. Only a symlinked ancestor whose physical target remains before the physical repository (such as `/tmp` to `/private/tmp`) is allowed; any leaf or parent symlink that resolves into the repository is refused, even when its pathname is outside the repository. External regular files are also refused. Inputs must be usable completed reports with the fixed canonical 17-descriptor normalized set. Duplicate run IDs/indexes, failed/interrupted reports, unsupported schema versions, missing metrics, and mixed cohorts are refused. A cohort identity is exactly the scenario, scenario class, normalized-controls hash, fixture-lock SHA-256, app executable SHA-256, git commit, and that canonical role/metric/unit set. Fixture regeneration or a changed fixture lock creates a different cohort.

Each run contributes one median for each role/metric/unit; periodic samples are never pooled across runs. `summary.json` uses `$schema: "clarus.perf.summary"`; `summary.json`, `summary.csv`, and `summary.txt` retain unrounded values in machine output and render at most six significant digits for people (`NA` when unavailable). Statistics are median, nearest-rank p95, min/max/span, mean, sample standard deviation (`n - 1`), and CV. Runtime cohorts require at least 5 runs; startup cohorts require 10. Lower counts remain visible as `insufficient-n`, rather than becoming a performance conclusion.

Run all non-production performance tooling tests serially with:

```sh
npm run perf:test
```
