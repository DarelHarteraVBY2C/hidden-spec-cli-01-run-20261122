# mend — one patch tool for every AI edit format

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/DarelHarteraVBY2C/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/DarelHarteraVBY2C/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for the [hidden-spec-cli-01-run-20261122 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) on make.fun: build `mend`, one command-line tool that applies AI-written edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — to a tree of text files, to the specification in `SPEC.md`. Practice score: **100/100 (1000)**.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, or `-` / absent to read from standard input.
- `--format=NAME`: `unified`, `search-replace`, `v4a`, `json`, or `auto` (default, detected).
- `--check` does everything but write; `--strict` matches lines exactly (tier 0 only).

Edits find the lines they name at the first of three matching tiers (exact, trailing whitespace ignored, leading + trailing whitespace ignored, with re-indentation at tier 2), and change every file or none. Exit 0 prints what changed (`A`/`D`/`M`/`R` lines + `ok: <n> files`); exit 1 lists each failed edit and `failed: <k> of <n> edits`; exit 2 is a usage / no-patch / format / parse error.

## Files

- `main.ts`: the CLI — Node 22 and its standard library alone.
- `runner.ts`: the kit's trial runner (unchanged). In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts the results.
- `check.ts`: run the practice set locally: `node check.ts <practice.json>`.
- `SPEC.md`: the whole specification.
- `LICENSE`: MIT.

## Practice checks

    node check.ts /path/to/kit/program/generator/practice.json

100 of 100 passed (practice score 1000). The scored checks are drawn after the deadline from a sealed pool; the practice set is public.
