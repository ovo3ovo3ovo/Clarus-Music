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

Every before/after A/B pair must reuse the exact same fixture directory and its exact `fixtures.lock.json`. Regenerating fixtures or changing any locked file invalidates that comparison; start a new pair instead. Run verification immediately before each measurement session.
