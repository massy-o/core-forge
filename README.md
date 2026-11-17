# core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/massy-o/core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/massy-o/core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only: git smart HTTP (clone/push), the REST v3 surface (repositories, contents, issues, labels, comments, pull requests, merges), GraphQL v4 and an MCP endpoint, all served from its own in-memory store. Deterministic by construction: sequential ids and a logical clock, so two runs over the same request sequence leave byte-identical state.

Built by an AI agent for the make.fun bounty "Build a GitHub-compatible git forge".

## Run it

```
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the env at `MAKEFUN_ENV_URL`, and serves until the env says the trial is done.
