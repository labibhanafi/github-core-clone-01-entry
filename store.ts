// store.ts — the forge's own store: a content-addressed git object store plus the
// repository / issue / pull-request records every surface (REST, git smart HTTP,
// GraphQL, MCP) shares. In-memory, one process, no outside service.
//
// Determinism: wall-clock time never enters the state. Timestamps come from a
// logical clock seeded at the scenario epoch, and every id comes from a counter,
// so a live run and its replay — the same requests in the same order — produce
// the same objects, the same ids and the same bytes.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const ZERO_OID = '0000000000000000000000000000000000000000';
export const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, the scenario epoch

// ------------------------------------------------------------------ logical clock + ids

let clockSeq = 0;
/** The next logical timestamp (seconds since the epoch), strictly increasing. */
export function tickSec() {
  clockSeq += 1;
  return EPOCH_SEC + clockSeq;
}
export function isoOf(sec) {
  return new Date(sec * 1000).toISOString();
}
export function nowIso() {
  return isoOf(tickSec());
}

let repoIdSeq = 0;
let issueDbIdSeq = 0;
let commentIdSeq = 0;
let requestSeq = 0;
export function nextRepoId() { repoIdSeq += 1; return repoIdSeq; }
export function nextIssueDbId() { issueDbIdSeq += 1; return issueDbIdSeq; }
export function nextCommentId() { commentIdSeq += 1; return commentIdSeq; }
export function nextRequestId() {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

// ------------------------------------------------------------------ object store

/** oid (hex) -> { type: 'blob'|'tree'|'commit'|'tag', data: Buffer } */
export const objects = new Map();

export function hashObject(type, data) {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function storeObject(type, data) {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid) {
  return objects.get(oid) ?? null;
}

export function hasObject(oid) {
  return objects.has(oid);
}

// ------------------------------------------------------------------ commits

/** Parse a commit object body into its parts. */
export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = null;
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const timeMatch = / (\d+) [+-]\d{4}$/.exec(committer);
  return {
    tree,
    parents,
    author,
    committer,
    message,
    time: timeMatch ? Number(timeMatch[1]) : 0,
  };
}

/** The identity line REST-side commits carry (the token's owner, logical time). */
export function identityLine(sec) {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${sec} +0000`;
}

/** Build and store a commit object; returns its oid. */
export function makeCommit({ tree, parents, message, sec }) {
  const when = sec ?? tickSec();
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identityLine(when)}`);
  lines.push(`committer ${identityLine(when)}`);
  const body = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
  return storeObject('commit', body);
}

// ------------------------------------------------------------------ tags

/** Parse an annotated tag object body. */
export function parseTag(data) {
  const text = data.toString('utf8');
  let object = null;
  let type = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

/** Follow tag objects to the commit they ultimately name (or null). */
export function peelToCommit(oid) {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = getObject(current);
    if (obj === null) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const tag = parseTag(obj.data);
    if (tag.object === null) return null;
    current = tag.object;
  }
  return null;
}

// ------------------------------------------------------------------ trees

/** Parse a tree object body into entries [{ mode, name, oid }]. */
export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry) {
  // Git orders tree entries by name, directories as if suffixed with '/'.
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** Serialize entries into a tree object body (git ordering) and store it. */
export function storeTree(entries) {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return storeObject('tree', Buffer.concat(parts));
}

export const EMPTY_TREE_OID = storeTree([]);

/** Flatten a tree (recursively) into a Map of path -> { oid, mode }. */
export function flattenTree(treeOid, prefix = '', out = new Map()) {
  if (treeOid === null || treeOid === undefined) return out;
  const obj = getObject(treeOid);
  if (obj === null || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      flattenTree(entry.oid, path, out);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Build nested trees from a flat Map of path -> { oid, mode }; returns the root tree oid. */
export function treeFromFiles(files) {
  const root = new Map(); // name -> { file?: {oid, mode}, dir?: Map }
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!node.has(parts[i])) node.set(parts[i], new Map());
      node = node.get(parts[i]);
    }
    node.set(parts[parts.length - 1], file);
  }
  const build = (node) => {
    const entries = [];
    for (const [name, value] of node) {
      if (value instanceof Map) entries.push({ mode: '40000', name, oid: build(value) });
      else entries.push({ mode: value.mode ?? '100644', name, oid: value.oid });
    }
    return storeTree(entries);
  };
  return build(root);
}

/** The entry at `parts` under a tree: { oid, mode, type: 'blob'|'tree' } or null. */
export function treeEntryAt(treeOid, parts) {
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    if (current === null) return null;
    const obj = getObject(current);
    if (obj === null || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) {
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      return { oid: entry.oid, mode: entry.mode, type: isDir ? 'tree' : 'blob' };
    }
    current = entry.oid;
  }
  return null;
}

/** The entries of the directory at `parts` under a tree (root when parts is empty). */
export function treeListAt(treeOid, parts) {
  let current = treeOid;
  for (const part of parts) {
    if (current === null) return null;
    const obj = getObject(current);
    if (obj === null || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part);
    if (entry === undefined) return null;
    current = entry.oid;
  }
  if (current === null) return null;
  const obj = getObject(current);
  if (obj === null || obj.type !== 'tree') return null;
  return parseTree(obj.data);
}

/**
 * A new root tree with the file at `parts` set to `blobOid` (or removed when
 * blobOid is null), starting from `treeOid` (or the empty tree). Empty
 * directories left behind by a removal are pruned, as git does.
 */
export function treeWithFile(treeOid, parts, blobOid) {
  const files = flattenTree(treeOid ?? EMPTY_TREE_OID);
  const path = parts.join('/');
  if (blobOid === null) files.delete(path);
  else files.set(path, { oid: blobOid, mode: '100644' });
  return treeFromFiles(files);
}

// ------------------------------------------------------------------ history walks

/** Every object reachable from the given tips (commits, their trees and blobs, tags). */
export function reachableClosure(tips) {
  const seen = new Set();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === undefined || seen.has(oid) || !hasObject(oid)) continue;
    seen.add(oid);
    const obj = getObject(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit.tree !== null) stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag.object !== null) stack.push(tag.object);
    }
  }
  return seen;
}

/** Commits reachable from `tip`, newest first (by committer time, then discovery). */
export function commitHistory(tip) {
  const out = [];
  const seen = new Set();
  let frontier = tip === null ? [] : [tip];
  while (frontier.length > 0) {
    // Take the newest commit on the frontier each round: a linear history
    // comes out in exact order, merges interleave by time.
    let bestIdx = 0;
    let bestTime = -1;
    for (let i = 0; i < frontier.length; i += 1) {
      const obj = getObject(frontier[i]);
      if (obj === null || obj.type !== 'commit') continue;
      const t = parseCommit(obj.data).time;
      if (t > bestTime) { bestTime = t; bestIdx = i; }
    }
    const oid = frontier.splice(bestIdx, 1)[0];
    if (oid === undefined || seen.has(oid)) continue;
    const obj = getObject(oid);
    if (obj === null || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) {
      if (!seen.has(parent)) frontier.push(parent);
    }
  }
  return out;
}

/** Whether `ancestor` is reachable from `descendant` through commit parents. */
export function isAncestor(ancestor, descendant) {
  if (ancestor === descendant) return true;
  const seen = new Set();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === undefined || seen.has(oid)) continue;
    if (oid === ancestor) return true;
    seen.add(oid);
    const obj = getObject(oid);
    if (obj === null || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** Generation (longest parent-chain distance to a root) of every commit reachable from tips. */
function generationsFrom(tips) {
  const gens = new Map();
  const order = [];
  const seen = new Set();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === undefined || seen.has(oid)) continue;
    const obj = getObject(oid);
    if (obj === null || obj.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  // Process in reverse discovery (children before parents is not guaranteed by
  // DFS order, so iterate to a fixed point — histories here are small).
  for (const oid of order) gens.set(oid, 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (const oid of order) {
      const commit = parseCommit(getObject(oid).data);
      let g = 0;
      for (const parent of commit.parents) {
        if (gens.has(parent)) g = Math.max(g, gens.get(parent) + 1);
      }
      if (g !== gens.get(oid)) { gens.set(oid, g); changed = true; }
    }
  }
  return gens;
}

/** A best common ancestor of two commits (the one with the greatest generation). */
export function mergeBase(a, b) {
  if (a === null || b === null) return null;
  const ancestorsOfA = new Set(commitHistory(a));
  const gens = generationsFrom([a, b]);
  let best = null;
  let bestGen = -1;
  for (const oid of commitHistory(b)) {
    if (ancestorsOfA.has(oid)) {
      const g = gens.get(oid) ?? 0;
      if (g > bestGen) { bestGen = g; best = oid; }
    }
  }
  return best;
}

/**
 * File-level three-way merge of two branch tips against their merge base.
 * Returns { files: Map } on success, or { conflict: path } when both sides
 * changed the same file differently (including modify-vs-delete).
 */
export function threeWayMerge(baseTip, headTip) {
  const base = mergeBase(baseTip, headTip);
  const baseFiles = base === null ? new Map() : flattenTree(parseCommit(getObject(base).data).tree);
  const oursFiles = flattenTree(parseCommit(getObject(baseTip).data).tree);
  const theirsFiles = flattenTree(parseCommit(getObject(headTip).data).tree);
  const paths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  const merged = new Map();
  for (const path of paths) {
    const inBase = baseFiles.get(path)?.oid ?? null;
    const inOurs = oursFiles.get(path)?.oid ?? null;
    const inTheirs = theirsFiles.get(path)?.oid ?? null;
    if (inTheirs === inBase) {
      // Their side did not touch it: keep ours (changed or not).
      if (inOurs !== null) merged.set(path, oursFiles.get(path));
    } else if (inOurs === inBase) {
      // Our side did not touch it: take theirs (a change or a deletion).
      if (inTheirs !== null) merged.set(path, theirsFiles.get(path));
    } else if (inOurs === inTheirs) {
      // Both sides made the same change.
      if (inOurs !== null) merged.set(path, oursFiles.get(path));
    } else {
      return { conflict: path };
    }
  }
  return { files: merged };
}

/** Whether merging `headTip` into `baseTip` would conflict (for mergeable). */
export function wouldConflict(baseTip, headTip) {
  if (baseTip === null || headTip === null) return false;
  if (isAncestor(headTip, baseTip)) return false; // already up to date
  return threeWayMerge(baseTip, headTip).conflict !== undefined;
}

/** The file diff between two commit trees: [{ path, status, oldOid, newOid }]. */
export function diffCommits(baseTip, headTip) {
  const baseFiles = baseTip === null ? new Map() : flattenTree(parseCommit(getObject(baseTip).data).tree);
  const headFiles = headTip === null ? new Map() : flattenTree(parseCommit(getObject(headTip).data).tree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out = [];
  for (const path of [...paths].sort()) {
    const oldOid = baseFiles.get(path)?.oid ?? null;
    const newOid = headFiles.get(path)?.oid ?? null;
    if (oldOid === newOid) continue;
    out.push({
      path,
      status: oldOid === null ? 'added' : newOid === null ? 'removed' : 'modified',
      oldOid,
      newOid,
    });
  }
  return out;
}

/** Line counts of a blob (a final line without a newline still counts). */
export function lineCount(oid) {
  if (oid === null) return 0;
  const obj = getObject(oid);
  if (obj === null) return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Added/deleted line counts between two blob versions (LCS over lines). */
export function lineDiff(oldOid, newOid) {
  const linesOf = (oid) => {
    if (oid === null) return [];
    const obj = getObject(oid);
    if (obj === null) return [];
    const text = obj.data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    return lines;
  };
  const a = linesOf(oldOid);
  const b = linesOf(newOid);
  // LCS length via dynamic programming (files in play are small).
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const common = prev[n];
  return { additions: n - common, deletions: m - common };
}

// ------------------------------------------------------------------ repositories

/** key `${owner}/${name}` -> repo record */
export const repos = new Map();

export function repoKey(owner, name) {
  return `${owner}/${name}`;
}

export function createRepoRecord({ name, isPrivate, description }) {
  const repo = {
    id: nextRepoId(),
    owner: VIEWER_LOGIN,
    name,
    private: isPrivate === true,
    description: description ?? '',
    defaultBranch: 'main',
    refs: new Map(), // full ref name -> oid
    labels: new Map(),
    issues: new Map(), // number -> issue (issues only)
    pulls: new Map(), // number -> pull (pull requests only)
    nextNumber: 1, // one sequence shared by issues and pull requests
    createdSec: tickSec(),
  };
  repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

export function getRepo(owner, name) {
  if (owner !== VIEWER_LOGIN) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

export function deleteRepo(owner, name) {
  return repos.delete(repoKey(owner, name));
}

export function listRepos() {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

/** The commit oid a branch ref names, or null. */
export function branchTip(repo, branch) {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** All branch names of a repo, in ref order. */
export function branchNames(repo) {
  const names = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
  }
  return names.sort();
}

/** All refs of a repo as [refName, oid] pairs, sorted by ref name. */
export function sortedRefs(repo) {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ------------------------------------------------------------------ issues + pulls

export function newIssueRecord(repo, { title, body, labels }) {
  const sec = tickSec();
  const issue = {
    dbId: nextIssueDbId(),
    number: repo.nextNumber,
    title: title ?? '',
    body: body ?? '',
    state: 'open',
    labels: labels ?? [],
    comments: [],
    createdSec: sec,
    updatedSec: sec,
    closedSec: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function newPullRecord(repo, { title, body, head, base }) {
  const sec = tickSec();
  const pull = {
    dbId: nextIssueDbId(),
    number: repo.nextNumber,
    title: title ?? '',
    body: body ?? '',
    state: 'open',
    merged: false,
    mergedSec: null,
    mergeCommitSha: null,
    head,
    base,
    comments: [],
    createdSec: sec,
    updatedSec: sec,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function newCommentRecord({ body }) {
  const sec = tickSec();
  return { id: nextCommentId(), body: body ?? '', createdSec: sec, updatedSec: sec };
}

/**
 * Merge a pull request into its base branch (squash or merge commit),
 * updating the ref and the pull record. Returns { ok: true, sha } or
 * { ok: false, conflict: true } / { ok: false, reason }.
 */
export function performMerge(repo, pull, method = 'squash') {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'a branch is missing' };
  if (pull.merged) return { ok: false, reason: 'already merged' };
  let sha;
  if (isAncestor(headTip, baseTip)) {
    sha = baseTip; // the head is already contained in the base
  } else {
    const merged = threeWayMerge(baseTip, headTip);
    if (merged.conflict !== undefined) return { ok: false, conflict: true };
    const tree = treeFromFiles(merged.files);
    if (method === 'merge') {
      sha = makeCommit({
        tree,
        parents: [baseTip, headTip],
        message: `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`,
      });
    } else {
      const message = pull.body ? `${pull.title}\n\n${pull.body}` : pull.title;
      sha = makeCommit({ tree, parents: [baseTip], message });
    }
    repo.refs.set(`refs/heads/${pull.base}`, sha);
  }
  const sec = tickSec();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSec = sec;
  pull.mergeCommitSha = sha;
  pull.updatedSec = sec;
  return { ok: true, sha };
}

// ------------------------------------------------------------------ GraphQL global ids

/** Opaque, stable global ids (never the plain database id / number). */
export function globalId(kind, ...parts) {
  return Buffer.from(`gid://forge/${kind}/${parts.join('/')}`, 'utf8').toString('base64');
}

export function parseGlobalId(id) {
  if (typeof id !== 'string') return null;
  let text;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^gid:\/\/forge\/([A-Za-z]+)\/(.+)$/.exec(text);
  if (match === null) return null;
  return { kind: match[1], parts: match[2].split('/') };
}

export function repoGlobalId(repo) {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo, issue) {
  return globalId('Issue', repo.id, issue.number);
}

export function pullGlobalId(repo, pull) {
  return globalId('PullRequest', repo.id, pull.number);
}

export function commentGlobalId(comment) {
  return globalId('IssueComment', comment.id);
}

export function findRepoByDbId(dbId) {
  for (const repo of repos.values()) if (repo.id === dbId) return repo;
  return null;
}
