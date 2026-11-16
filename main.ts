// main.ts — the forge: one Node process serving git smart HTTP, the REST v3
// API under /api/v3, GraphQL v4 at /api/graphql and MCP at /mcp, all over the
// store in store.ts. Boot follows the suite protocol: bind an ephemeral port,
// POST {port} to $MAKEFUN_ENV_URL/register, serve, poll /done, exit 0.

import { createServer } from 'node:http';
import {
  VIEWER_LOGIN,
  VIEWER_NAME,
  VIEWER_EMAIL,
  VIEWER_ID,
  ZERO_OID,
  repos,
  getRepo,
  createRepoRecord,
  deleteRepo,
  listRepos,
  branchTip,
  branchNames,
  getObject,
  storeObject,
  parseCommit,
  treeEntryAt,
  treeListAt,
  treeWithFile,
  flattenTree,
  commitHistory,
  makeCommit,
  diffCommits,
  lineCount,
  lineDiff,
  isoOf,
  tickSec,
  nextRequestId,
  newIssueRecord,
  newPullRecord,
  newCommentRecord,
  performMerge,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  EMPTY_TREE_OID,
} from './store.ts';
import { infoRefs, handleUploadPackV2, handleUploadPackV0, handleReceivePack } from './gitproto.ts';
import { executeGraphQL } from './graphql.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

// ------------------------------------------------------------------ http helpers

function authed(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  if (TOKEN === '') return true; // local runs only; a trial always sets the token
  return header.slice('Bearer '.length) === TOKEN;
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = value === null || value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 32 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Read a JSON body; on malformed JSON answer 400 and return undefined. */
async function readJsonBody(req, res) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return undefined;
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ------------------------------------------------------------------ JSON shapes

function userJson(login = VIEWER_LOGIN) {
  return { login, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function repoJson(repo) {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdSec),
    updated_at: isoOf(repo.createdSec),
    html_url: `/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    fork: false,
    forks_count: 0,
    watchers_count: 0,
    stargazers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function labelJson(label) {
  return {
    name: label.name,
    color: label.color,
    description: label.description ?? null,
    default: false,
  };
}

function issueJson(repo, issue) {
  return {
    id: issue.dbId,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name, color: '000000', description: null } : labelJson(label);
    }),
    user: userJson(),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.updatedSec),
    closed_at: issue.closedSec === null ? null : isoOf(issue.closedSec),
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo, pull) {
  return {
    id: pull.dbId,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedSec === null ? null : isoOf(pull.mergedSec),
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.head,
      label: `${repo.owner}:${pull.head}`,
      sha: branchTip(repo, pull.head),
    },
    base: {
      ref: pull.base,
      label: `${repo.owner}:${pull.base}`,
      sha: branchTip(repo, pull.base),
    },
    user: userJson(),
    draft: false,
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.updatedSec),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedSec) : null,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentJson(comment) {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(),
    created_at: isoOf(comment.createdSec),
    updated_at: isoOf(comment.updatedSec),
  };
}

function commitJson(oid) {
  const commit = parseCommit(getObject(oid).data);
  const person = (line) => {
    const match = /^(.*) <(.*)> (\d+) /.exec(line ?? '');
    return match === null
      ? { name: '', email: '', date: isoOf(commit.time) }
      : { name: match[1], email: match[2], date: isoOf(Number(match[3])) };
  };
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author: person(commit.author),
      committer: person(commit.committer),
      tree: { sha: commit.tree },
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------------ pagination

function pageParams(url) {
  const perPageRaw = Number(url.searchParams.get('per_page'));
  const pageRaw = Number(url.searchParams.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

function paginate(req, url, items) {
  const { perPage, page } = pageParams(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers = {};
  if (start + perPage < items.length) {
    const next = new URLSearchParams(url.searchParams);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    const host = req.headers.host ?? '127.0.0.1';
    headers.link = `<http://${host}${url.pathname}?${next.toString()}>; rel="next"`;
  }
  return { slice, headers };
}

// ------------------------------------------------------------------ REST: repos

async function handleRest(req, res, url, segments) {
  const method = req.method ?? 'GET';
  // segments: the path under /api/v3, split and decoded.
  const rest = segments.slice(2);

  // Root + meta + the token's user.
  if (rest.length === 0) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, {
      installed_version: '1.0.0',
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      hooks: [],
    });
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, userJson());
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const { slice, headers } = paginate(req, url, listRepos().map(repoJson));
      return sendJson(res, 200, slice, headers);
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return sendError(res, 422, 'Validation Failed: name is required');
      if (getRepo(VIEWER_LOGIN, name) !== null) {
        return sendError(res, 422, `Validation Failed: a repository named ${name} already exists`);
      }
      const repo = createRepoRecord({
        name,
        isPrivate: body.private === true,
        description: typeof body.description === 'string' ? body.description : '',
      });
      return sendJson(res, 201, repoJson(repo));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (rest[0] !== 'repos' || rest.length < 3) return sendError(res, 404, 'Not Found');
  const owner = rest[1];
  const repoName = rest[2];
  const repo = getRepo(owner, repoName);
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (repo === null) return sendError(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        // A rename moves the record.
        const clash = getRepo(VIEWER_LOGIN, body.name);
        if (clash !== null) return sendError(res, 422, 'Validation Failed: name already exists');
        repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = body.name;
        repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(owner, repoName);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      return res.end();
    }
    return sendError(res, 404, 'Not Found');
  }

  if (repo === null) return sendError(res, 404, 'Not Found');
  return handleRepoScoped(req, res, url, method, repo, tail);
}

async function handleRepoScoped(req, res, url, method, repo, tail) {
  // ---- branches
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const list = branchNames(repo).map((name) => ({
        name,
        commit: { sha: branchTip(repo, name) },
        protected: false,
      }));
      return sendJson(res, 200, list);
    }
    if (tail.length >= 2 && method === 'GET') {
      const name = tail.slice(1).join('/');
      const tip = branchTip(repo, name);
      if (tip === null) return sendError(res, 404, 'Branch not found');
      return sendJson(res, 200, { name, commit: { sha: tip }, protected: false });
    }
    return sendError(res, 404, 'Not Found');
  }

  // ---- commits
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const ref = url.searchParams.get('sha');
    let tip = null;
    if (ref === null || ref === '') tip = branchTip(repo, repo.defaultBranch);
    else if (branchTip(repo, ref) !== null) tip = branchTip(repo, ref);
    else if (/^[0-9a-f]{40}$/.test(ref) && getObject(ref)?.type === 'commit') tip = ref;
    if (tip === null) return sendJson(res, 200, []);
    const history = commitHistory(tip).map(commitJson);
    const { slice, headers } = paginate(req, url, history);
    return sendJson(res, 200, slice, headers);
  }

  // ---- contents
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    return handleContents(req, res, url, method, repo, path);
  }

  // ---- git refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2) {
      if (method === 'POST') {
        const body = await readJsonBody(req, res);
        if (body === undefined) return;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || getObject(sha) === null) {
          return sendError(res, 422, 'Validation Failed: ref or sha is invalid');
        }
        repo.refs.set(ref, sha);
        return sendJson(res, 201, { ref, object: { sha, type: getObject(sha).type } });
      }
      if (method === 'GET') {
        const list = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } }));
        return sendJson(res, 200, list);
      }
      return sendError(res, 404, 'Not Found');
    }
    if (method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return sendError(res, 404, 'Reference not found');
      return sendJson(res, 200, { ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } });
    }
    if (method === 'DELETE') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      repo.refs.delete(ref);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      return res.end();
    }
    return sendError(res, 404, 'Not Found');
  }

  // ---- labels
  if (tail[0] === 'labels') {
    if (tail.length === 1 && method === 'GET') {
      return sendJson(res, 200, [...repo.labels.values()].map(labelJson));
    }
    if (tail.length === 1 && method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return sendError(res, 422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return sendError(res, 422, 'Validation Failed: label already exists');
      const label = {
        name,
        color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : '000000',
        description: typeof body.description === 'string' ? body.description : null,
      };
      repo.labels.set(name, label);
      return sendJson(res, 201, labelJson(label));
    }
    return sendError(res, 404, 'Not Found');
  }

  // ---- issues + comments
  if (tail[0] === 'issues') {
    return handleIssues(req, res, url, method, repo, tail);
  }

  // ---- pulls
  if (tail[0] === 'pulls') {
    return handlePulls(req, res, url, method, repo, tail);
  }

  return sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ REST: contents

async function handleContents(req, res, url, method, repo, path) {
  const parts = path === '' ? [] : path.split('/').filter((p) => p !== '');
  const refParam = url.searchParams.get('ref');
  const resolveTip = () => {
    if (refParam !== null && refParam !== '') {
      const byBranch = branchTip(repo, refParam);
      if (byBranch !== null) return byBranch;
      if (/^[0-9a-f]{40}$/.test(refParam) && getObject(refParam)?.type === 'commit') return refParam;
      return null;
    }
    return branchTip(repo, repo.defaultBranch);
  };

  if (method === 'GET') {
    const tip = resolveTip();
    if (tip === null) return sendError(res, 404, 'Not Found');
    const tree = parseCommit(getObject(tip).data).tree;
    if (parts.length === 0) {
      const entries = treeListAt(tree, []);
      return sendJson(res, 200, entries.map((e) => dirEntryJson(repo, e, '')));
    }
    const entry = treeEntryAt(tree, parts);
    if (entry === null) return sendError(res, 404, 'Not Found');
    if (entry.type === 'tree') {
      const entries = treeListAt(tree, parts) ?? [];
      return sendJson(res, 200, entries.map((e) => dirEntryJson(repo, e, path)));
    }
    const blob = getObject(entry.oid);
    return sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      name: parts[parts.length - 1],
      path,
      sha: entry.oid,
      size: blob.data.length,
      content: blob.data.toString('base64'),
    });
  }

  if (method === 'PUT') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    if (parts.length === 0) return sendError(res, 422, 'Validation Failed: path is required');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    let tip = branchTip(repo, branch);
    if (tip === null && branch !== repo.defaultBranch) {
      // A write to a branch that does not exist yet forks it from the default.
      tip = branchTip(repo, repo.defaultBranch);
    }
    const baseTree = tip === null ? EMPTY_TREE_OID : parseCommit(getObject(tip).data).tree;
    const existing = treeEntryAt(baseTree, parts);
    let status = 201;
    if (existing !== null && existing.type === 'blob') {
      if (typeof body.sha === 'string' && body.sha !== existing.oid) {
        return sendError(res, 409, 'Conflict: the sha does not match the current file');
      }
      status = 200;
    }
    const content = typeof body.content === 'string' ? body.content : '';
    const blobOid = storeObject('blob', Buffer.from(content.replace(/\s+/g, ''), 'base64'));
    const newTree = treeWithFile(baseTree, parts, blobOid);
    const commitOid = makeCommit({
      tree: newTree,
      parents: tip === null ? [] : [tip],
      message: typeof body.message === 'string' ? body.message : '',
    });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return sendJson(res, status, {
      content: {
        type: 'file',
        name: parts[parts.length - 1],
        path,
        sha: blobOid,
        size: getObject(blobOid).data.length,
        encoding: 'base64',
      },
      commit: { sha: commitOid, message: typeof body.message === 'string' ? body.message : '' },
    });
  }

  if (method === 'DELETE') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (tip === null) return sendError(res, 404, 'Not Found');
    const baseTree = parseCommit(getObject(tip).data).tree;
    const existing = treeEntryAt(baseTree, parts);
    if (existing === null || existing.type !== 'blob') return sendError(res, 404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      return sendError(res, 409, 'Conflict: the sha does not match the current file');
    }
    const newTree = treeWithFile(baseTree, parts, null);
    const commitOid = makeCommit({
      tree: newTree,
      parents: [tip],
      message: typeof body.message === 'string' ? body.message : '',
    });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return sendJson(res, 200, { content: null, commit: { sha: commitOid } });
  }

  return sendError(res, 404, 'Not Found');
}

function dirEntryJson(repo, entry, parentPath) {
  const isDir = entry.mode === '40000' || entry.mode === '040000';
  const path = parentPath === '' ? entry.name : `${parentPath}/${entry.name}`;
  const out = {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
  };
  if (!isDir) {
    const blob = getObject(entry.oid);
    if (blob !== null) out.size = blob.data.length;
  }
  void repo;
  return out;
}

// ------------------------------------------------------------------ REST: issues

function labelNamesOf(body) {
  if (!Array.isArray(body.labels)) return [];
  return body.labels.map((label) => {
    if (typeof label === 'string') return label;
    if (label !== null && typeof label === 'object' && typeof label.name === 'string') return label.name;
    return '';
  }).filter((name) => name !== '');
}

async function handleIssues(req, res, url, method, repo, tail) {
  if (tail.length === 1) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((i) => i.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice, headers } = paginate(req, url, items.map((i) => issueJson(repo, i)));
      return sendJson(res, 200, slice, headers);
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      const labels = labelNamesOf(body);
      for (const name of labels) {
        if (!repo.labels.has(name)) {
          return sendError(res, 422, `Validation Failed: label '${name}' does not exist`);
        }
      }
      const issue = newIssueRecord(repo, {
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        labels,
      });
      return sendJson(res, 201, issueJson(repo, issue));
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = Number(tail[1]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  const subject = issue ?? pull;

  if (tail.length === 2) {
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.labels !== undefined) {
        const labels = labelNamesOf(body);
        for (const name of labels) {
          if (!repo.labels.has(name)) return sendError(res, 422, `Validation Failed: label '${name}' does not exist`);
        }
        issue.labels = labels;
      }
      if (body.state === 'closed' || body.state === 'open') {
        issue.state = body.state;
        issue.closedSec = body.state === 'closed' ? tickSec() : null;
      }
      issue.updatedSec = tickSec();
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (tail.length === 3 && tail[2] === 'comments') {
    if (subject === undefined) return sendError(res, 404, 'Not Found');
    if (method === 'GET') {
      const { slice, headers } = paginate(req, url, subject.comments.map(commentJson));
      return sendJson(res, 200, slice, headers);
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      const comment = newCommentRecord({ body: typeof body.body === 'string' ? body.body : '' });
      subject.comments.push(comment);
      return sendJson(res, 201, commentJson(comment));
    }
    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ REST: pulls

function stripOwnerPrefix(ref) {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

async function handlePulls(req, res, url, method, repo, tail) {
  if (tail.length === 1) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      const { slice, headers } = paginate(req, url, items.map((p) => pullJson(repo, p)));
      return sendJson(res, 200, slice, headers);
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      const head = stripOwnerPrefix(typeof body.head === 'string' ? body.head : '');
      const base = stripOwnerPrefix(typeof body.base === 'string' ? body.base : '');
      if (branchTip(repo, head) === null) return sendError(res, 422, `Validation Failed: head branch '${head}' does not exist`);
      if (branchTip(repo, base) === null) return sendError(res, 422, `Validation Failed: base branch '${base}' does not exist`);
      const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (existing !== undefined) {
        return sendError(res, 422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
      }
      const pull = newPullRecord(repo, {
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        head,
        base,
      });
      return sendJson(res, 201, pullJson(repo, pull));
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = Number(tail[1]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (tail.length === 2 && method === 'GET') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, pullJson(repo, pull));
  }

  if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    const baseTip = branchTip(repo, pull.base);
    const headTip = branchTip(repo, pull.head);
    const diff = baseTip === null || headTip === null ? [] : diffCommits(baseTip, headTip);
    const files = diff.map((entry) => {
      let additions = 0;
      let deletions = 0;
      if (entry.status === 'added') additions = lineCount(entry.newOid);
      else if (entry.status === 'removed') deletions = lineCount(entry.oldOid);
      else ({ additions, deletions } = lineDiff(entry.oldOid, entry.newOid));
      return {
        filename: entry.path,
        status: entry.status,
        additions,
        deletions,
        changes: additions + deletions,
        sha: entry.newOid,
      };
    });
    const { slice, headers } = paginate(req, url, files);
    return sendJson(res, 200, slice, headers);
  }

  if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    if (pull.merged) return sendError(res, 405, 'Pull Request is not mergeable: already merged');
    if (pull.state === 'closed') return sendError(res, 405, 'Pull Request is not mergeable: closed');
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
    const result = performMerge(repo, pull, mergeMethod === 'merge' ? 'merge' : 'squash');
    if (!result.ok) {
      if (result.conflict) return sendError(res, 405, 'Pull Request is not mergeable: merge conflict');
      return sendError(res, 405, `Pull Request is not mergeable: ${result.reason ?? 'unknown'}`);
    }
    return sendJson(res, 200, {
      sha: result.sha,
      merged: true,
      message: 'Pull Request successfully merged',
    });
  }

  return sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ git smart HTTP

function handleGit(req, res, url, segments) {
  const method = req.method ?? 'GET';
  const owner = segments[0];
  const repoName = segments[1].replace(/\.git$/, '');
  const repo = getRepo(owner, repoName);
  const action = segments.slice(2).join('/');

  if (action === 'info/refs' && method === 'GET') {
    if (repo === null) return sendError(res, 404, 'Not Found');
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return sendError(res, 400, 'Unknown service');
    }
    const protocolHeader = req.headers['git-protocol'] ?? '';
    const version = protocolHeader.includes('version=2') ? 2 : 0;
    const { contentType, body } = infoRefs(repo, service, version);
    res.writeHead(200, { 'content-type': contentType, 'x-github-request-id': nextRequestId() });
    return res.end(body);
  }

  if ((action === 'git-upload-pack' || action === 'git-receive-pack') && method === 'POST') {
    if (repo === null) return sendError(res, 404, 'Not Found');
    if (!authed(req)) return sendError(res, 401, 'Authentication required');
    return readBody(req).then((body) => {
      try {
        if (action === 'git-upload-pack') {
          const protocolHeader = req.headers['git-protocol'] ?? '';
          const out = protocolHeader.includes('version=2')
            ? handleUploadPackV2(repo, body)
            : handleUploadPackV0(repo, body);
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': nextRequestId() });
          res.end(out);
        } else {
          const out = handleReceivePack(repo, body);
          res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'x-github-request-id': nextRequestId() });
          res.end(out);
        }
      } catch (error) {
        // A malformed body must never take the server down.
        process.stderr.write(`git ${action} failed: ${error instanceof Error ? error.stack : String(error)}\n`);
        if (!res.headersSent) res.writeHead(200, { 'content-type': `application/x-${action}-result` });
        res.end();
      }
    }).catch(() => {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain' });
      res.end();
    });
  }

  return sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ MCP

const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'forge', version: '1.0.0' };

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The repository owner (the token owner; informational).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolOk(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function mcpCallTool(name, args) {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      if (repoNameArg === '') return toolError('create_repo requires a name');
      const existing = getRepo(VIEWER_LOGIN, repoNameArg);
      if (existing !== null) return toolOk(repoJson(existing));
      const repo = createRepoRecord({
        name: repoNameArg,
        isPrivate: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = getRepo(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      return toolOk(repoJson(repo));
    }
    case 'list_repos': {
      return toolOk(listRepos().map(repoJson));
    }
    case 'create_issue': {
      const repo = getRepo(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return toolError('create_issue requires a title');
      const issue = newIssueRecord(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = getRepo(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((i) => i.state === state);
      items.sort((a, b) => a.number - b.number);
      return toolOk(items.map((i) => issueJson(repo, i)));
    }
    case 'get_issue': {
      const repo = getRepo(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return toolError(`issue ${String(args.issue_number)} not found`);
      return toolOk(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = getRepo(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const head = stripOwnerPrefix(typeof args.head === 'string' ? args.head : '');
      const base = stripOwnerPrefix(typeof args.base === 'string' ? args.base : '');
      if (branchTip(repo, head) === null) return toolError(`head branch '${head}' does not exist`);
      if (branchTip(repo, base) === null) return toolError(`base branch '${base}' does not exist`);
      const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (existing !== undefined) return toolOk(pullJson(repo, existing));
      const pull = newPullRecord(repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      return toolOk(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = getRepo(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError(`pull request ${String(args.pull_number)} not found`);
      if (pull.merged) return toolOk(pullJson(repo, pull));
      const result = performMerge(repo, pull, 'squash');
      if (!result.ok) return toolError(result.conflict ? 'merge conflict' : (result.reason ?? 'merge failed'));
      return toolOk(pullJson(repo, pull));
    }
    default:
      return null; // unknown tool: the caller answers -32602
  }
}

/** Validate a tools/call's required arguments against the tool's own schema. */
function missingRequired(tool, args) {
  const required = tool.inputSchema.required ?? [];
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function mcpDispatch(message) {
  const method = typeof message.method === 'string' ? message.method : '';
  const params = message.params !== null && typeof message.params === 'object' ? message.params : {};
  switch (method) {
    case 'server/discover':
      return {
        result: {
          resultType: 'complete',
          supportedVersions: MCP_SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
          instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over one store.',
          _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
        },
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
        },
      };
    }
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: MCP_TOOLS } };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (tool === undefined) {
        return { error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
      const args = params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {};
      const missing = missingRequired(tool, args);
      if (missing.length > 0) {
        return { result: toolError(`missing required argument(s): ${missing.join(', ')}`) };
      }
      const result = mcpCallTool(name, args);
      if (result === null) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
      return { result };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

async function handleMcp(req, res) {
  if (!authed(req)) {
    res.writeHead(401, { 'content-type': 'application/json', 'x-github-request-id': nextRequestId() });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }));
  }
  const raw = (await readBody(req)).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const idMatch = /"id"\s*:\s*(\d+|"[^"]*")/.exec(raw);
    let id = null;
    if (idMatch !== null) {
      try { id = JSON.parse(idMatch[1]); } catch { id = null; }
    }
    res.writeHead(400, { 'content-type': 'application/json', 'x-github-request-id': nextRequestId() });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } }));
  }
  if (Array.isArray(parsed)) {
    const responses = [];
    for (const message of parsed) {
      if (message === null || typeof message !== 'object') continue;
      if (message.id === undefined) continue; // a notification inside a batch
      const { result, error } = mcpDispatch(message);
      responses.push(error !== undefined
        ? { jsonrpc: '2.0', id: message.id, error }
        : { jsonrpc: '2.0', id: message.id, result });
    }
    return sendJson(res, 200, responses);
  }
  if (parsed === null || typeof parsed !== 'object') {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }));
  }
  if (parsed.id === undefined) {
    // A notification: accepted, no answer body.
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    return res.end();
  }
  const { result, error } = mcpDispatch(parsed);
  if (error !== undefined) {
    return sendJson(res, 200, { jsonrpc: '2.0', id: parsed.id, error });
  }
  return sendJson(res, 200, { jsonrpc: '2.0', id: parsed.id, result });
}

// ------------------------------------------------------------------ the server

async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const rawPath = url.pathname;
  const segments = rawPath.split('/').filter((s) => s !== '').map(decodeSegment);

  if (rawPath === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }

  if (rawPath === '/mcp') {
    if (req.method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    return handleMcp(req, res);
  }

  if (rawPath === '/api/graphql') {
    if (req.method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    if (!authed(req)) return sendError(res, 401, 'Unauthorized');
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { data: null, errors: [{ message: 'Problems parsing JSON' }] });
    }
    if (Array.isArray(parsed)) {
      return sendJson(res, 200, parsed.map((entry) => executeGraphQL(entry)));
    }
    return sendJson(res, 200, executeGraphQL(parsed));
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authed(req)) return sendError(res, 401, 'Unauthorized');
    return handleRest(req, res, url, segments);
  }

  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    return handleGit(req, res, url, segments);
  }

  return sendError(res, 404, 'Not Found');
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.headersSent) {
      try {
        sendError(res, 500, 'Internal Server Error');
      } catch {
        // the socket is gone; nothing to answer
      }
    } else {
      try { res.end(); } catch { /* already closed */ }
    }
  });
});
server.keepAliveTimeout = 10000;
server.headersTimeout = 15000;

// ------------------------------------------------------------------ boot protocol

async function registerAndServe() {
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (ENV_URL === '') {
    // Local run: no suite to register with; serve until stopped.
    process.stderr.write(`forge listening on ${port} (no MAKEFUN_ENV_URL; serving standalone)\n`);
    return;
  }
  // Register the port with the suite (retrying briefly: it may still be booting).
  let registered = false;
  for (let attempt = 0; attempt < 120 && !registered; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok || response.status === 409) registered = true;
    } catch {
      // not up yet
    }
    if (!registered) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Long-poll /done until the suite has finished, then exit 0.
  for (;;) {
    try {
      const response = await fetch(`${ENV_URL}/done`);
      if (response.ok) {
        const body = await response.json();
        if (body !== null && typeof body === 'object' && body.done === true) break;
      }
    } catch {
      // a transient failure while polling is not the end
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  server.close();
  process.exit(0);
}

registerAndServe().catch((error) => {
  process.stderr.write(`forge failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
