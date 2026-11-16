[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/labibhanafi/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/labibhanafi/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a standalone GitHub-compatible git forge

One Node.js process, standard library only, no git binary, no database, no
outside service. It binds an ephemeral port, registers it with the suite
(`POST {port}` to `$MAKEFUN_ENV_URL/register`), serves four surfaces from its
own in-memory store, long-polls `/done`, and exits 0 when the suite is done.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 `ls-refs` and
  `fetch` (with shallow/deepen), the v0 fetch fallback, and v0 `receive-pack`
  pushes with `report-status`, `side-band-64k` and `delete-refs`. Packs and
  objects are implemented from scratch (SHA-1 object store, pack writer,
  pack reader with OFS/REF delta resolution).
- **REST v3** under `/api/v3` — repositories, contents (create/update/delete
  with blob-sha conflict checks), branches, commits, git refs, labels,
  issues, comments, pull requests (diff + squash/merge with file-level
  three-way merge, 405 on conflict), pagination via `Link` headers.
- **GraphQL v4** at `/api/graphql` — a small hand-written parser/executor
  for the documents `gh` and github-mcp-server send: viewer, repository,
  issues/pullRequests connections with cursor pagination and ordering,
  `node(id:)`, `__type` introspection, batched operations, and the
  createIssue / closeIssue / createPullRequest / mergePullRequest /
  addComment mutations, all over opaque stable global ids.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP: `server/discover`
  (revision 2026-07-28) plus the legacy `initialize` handshake, and the
  tools `create_repo`, `get_repo`, `list_repos`, `create_issue`,
  `list_issues`, `get_issue`, `create_pull_request`, `merge_pull_request`
  acting on the same store as REST.

## Design notes

- One content-addressed object store is shared by every surface: a file
  written through the contents API is the same blob a clone fetches, and a
  branch pushed over git is the same ref a pull request reads.
- Determinism: timestamps come from a logical clock seeded at a fixed epoch
  and every id from a counter, so a live run and its replay produce the same
  state.
- Auth: every surface requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`;
  `/healthz` is the only unauthenticated route.

## Files

- `main.ts` — HTTP server, REST v3, MCP, boot protocol.
- `store.ts` — object store, trees/commits, history walks, three-way merge,
  repository/issue/pull records, global ids.
- `gitproto.ts` — pkt-lines, pack read/write, advertisements, upload-pack,
  receive-pack.
- `graphql.ts` — GraphQL lexer/parser, schema, executor, introspection.

## Run

```sh
node main.ts   # with MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN set
```
