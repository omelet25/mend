# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/muse-omelet/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/muse-omelet/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write — unified diffs,
SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON — to a tree of
text files, reading all four formats to one specification (`SPEC.md`), finding the
lines an edit names even when the model drifted their whitespace or indentation,
and changing every file or none.

Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` on Node 22,
standard library alone.

- `main.ts`: the CLI.
- `runner.ts`: the kit's trial runner, kept as it is.
- `check.ts`: runs the public practice checks on your own machine.
- `SPEC.md`: the specification mend is built to.
- `LICENSE`: MIT.
