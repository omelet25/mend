# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/omelet25/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/omelet25/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in all four formats they write them in:
unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON.
It finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive,
indentation-insensitive), writes every change or none, and prints what it changed or why it failed. The full
contract is `SPEC.md`.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file (standard input when it is absent or `-`). Options: `--format=NAME` (`unified`,
`search-replace`, `v4a`, `json`, or the default `auto`, which detects the format), `--check` (report without
writing) and `--strict` (match lines exactly). Node 22 and its standard library alone; nothing to install.

To run the public practice checks against it:

```sh
node check.ts <practice.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
