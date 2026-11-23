# mend

[![make.fun competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/omelet25/mend/rank.svg)](https://make.fun/)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/omelet25/mend/reward.svg)](https://make.fun/)

mend is a command-line tool that applies an edit an AI model wrote to a tree of
text files. Models write edits in four formats — unified diffs (often with
wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON — and mend reads all four to one specification
([SPEC.md](SPEC.md)), finds the lines each edit names at the first of three
matching tiers (exact, trailing-whitespace-insensitive, and
indentation-insensitive), and writes every change or none.

Built for the make.fun competition
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory; with no
  argument (or `-`) the patch is read from standard input.
- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a` or
  `json`; the default, `auto`, detects the format.
- `--check` does everything but write: same output and exit code, no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

The working directory is the root of the tree; every path in a patch is
relative to it. Output lists what changed (`A`/`D`/`M`/`R` lines and an
`ok: <n> files` summary), or one `error: <code> <path>` line per failed edit
followed by `failed: <k> of <n> edits`. Exit codes: 0 when every edit applied,
1 when any edit failed (nothing is written), 2 for usage, unreadable-patch,
format and parse errors.

## Performance

A file is held as an array of its lines, and the searches are built so a
patch's cost stays proportional to the files' lines plus the patch's own
lines: tier comparisons normalise the single line being compared rather than
a whole-file copy, a unified hunk searches outward from the position it names
instead of rescanning the file per hunk, SEARCH/REPLACE counts occurrences
through its block's first line, and V4A chunks only scan forward from their
cursor. A 200-hunk patch over a million-line file applies in well under the
10-second per-run limit.

## Files

- `main.ts` — the CLI (Node 22, standard library alone).
- `runner.ts` — the kit's trial runner; `main.ts` hands over to it when
  `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs the public practice set (`node check.ts <practice.json>`).
- `SPEC.md` — the specification mend implements.
- `LICENSE` — MIT.
