// graphql.ts — a small GraphQL v4 executor for the forge: a hand-written
// lexer/parser for the document shapes gh and github-mcp-server send (named
// operations, variables, aliases, inline fragments, enum lists, input
// objects), a schema covering the fields the suite reads, introspection for
// __type, and the mutations that act on the same store as REST.

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  getRepo,
  findRepoByDbId,
  branchTip,
  parseCommit,
  getObject,
  diffCommits,
  wouldConflict,
  isoOf,
  tickSec,
  newIssueRecord,
  newPullRecord,
  newCommentRecord,
  performMerge,
  globalId,
  parseGlobalId,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
} from './store.ts';

// ------------------------------------------------------------------ lexer

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const isNameStart = (c) => /[_A-Za-z]/.test(c);
  const isNameChar = (c) => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i += 1; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push({ kind: 'spread' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      while (j < source.length && /[-+0-9.eE]/.test(source[j])) j += 1;
      const raw = source.slice(i, j);
      tokens.push({ kind: raw.includes('.') || /[eE]/.test(raw) ? 'float' : 'int', value: raw });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }

  next() { const t = this.tokens[this.pos]; this.pos += 1; return t; }

  expectPunct(value) {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}`);
  }

  expectName() {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected a name');
    return t.value;
  }

  atPunct(value) {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }

  parseDocument() {
    const operations = [];
    const fragments = new Map();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ type: 'query', name: null, varDefs: {}, selectionSet: this.parseSelectionSet() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        const type = this.next().value;
        let name = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.atPunct('(') ? this.parseVarDefs() : {};
        this.skipDirectives();
        operations.push({ type, name, varDefs, selectionSet: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        if (this.expectName() !== 'on') throw new Error('expected on in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error('unexpected token in document');
      }
    }
    return { operations, fragments };
  }

  parseVarDefs() {
    const defs = {};
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseTypeRef();
      let defaultValue;
      if (this.atPunct('=')) {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.skipDirectives();
      defs[name] = { defaultValue };
    }
    this.expectPunct(')');
    return defs;
  }

  parseTypeRef() {
    if (this.atPunct('[')) {
      this.next();
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  skipDirectives() {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.parseArgs();
    }
  }

  parseArgs() {
    const args = {};
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue(false);
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(isConst) {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new Error('variable in constant value');
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'string') { this.next(); return { kind: 'string', value: t.value }; }
    if (t.kind === 'int') { this.next(); return { kind: 'int', value: parseInt(t.value, 10) }; }
    if (t.kind === 'float') { this.next(); return { kind: 'float', value: parseFloat(t.value) }; }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const items = [];
      while (!this.atPunct(']')) items.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.next();
      const fields = {};
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue(isConst);
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }

  parseSelectionSet() {
    this.expectPunct('{');
    const selections = [];
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  parseSelection() {
    const t = this.peek();
    if (t.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'fragmentSpread', name };
    }
    let name = this.expectName();
    let alias = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArgs() : {};
    this.skipDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selectionSet };
  }
}

function evalValue(node, variables) {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
    default: return undefined;
  }
}

// ------------------------------------------------------------------ domain wrappers

const wrapUser = (login) => ({ __typename: 'User', login });
const wrapRepo = (repo) => ({ __typename: 'Repository', repo });
const wrapIssue = (repo, issue) => ({ __typename: 'Issue', repo, issue });
const wrapPull = (repo, pull) => ({ __typename: 'PullRequest', repo, pull });
const wrapRef = (repo, name, oid) => ({ __typename: 'Ref', repo, name, oid });
const wrapComment = (repo, issue, comment) => ({ __typename: 'IssueComment', repo, issue, comment });
const wrapCommit = (oid) => ({ __typename: 'Commit', oid });

function cursorOf(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor) {
  try {
    const text = Buffer.from(String(cursor), 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Slice a connection page out of an ordered item list. */
function pageOf(items, args, wrap) {
  const first = typeof args.first === 'number' ? args.first : 30;
  let start = 0;
  if (args.after !== undefined && args.after !== null) {
    const afterNumber = numberFromCursor(args.after);
    const index = items.findIndex((item) => item.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const slice = items.slice(start, start + first);
  const nodes = slice.map(wrap);
  return {
    __typename: 'Connection',
    nodes,
    edges: slice.map((item) => ({ node: wrap(item), cursor: cursorOf(item.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      endCursor: slice.length > 0 ? cursorOf(slice[slice.length - 1].number) : null,
      startCursor: slice.length > 0 ? cursorOf(slice[0].number) : null,
    },
    totalCount: items.length,
  };
}

function repoIssuesOrdered(repo, args) {
  let items = [...repo.issues.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy ?? null;
  const direction = orderBy !== null && typeof orderBy === 'object' ? orderBy.direction : undefined;
  if (direction === 'DESC') {
    items.sort((a, b) => (b.createdSec - a.createdSec) || (b.number - a.number));
  } else if (direction === 'ASC') {
    items.sort((a, b) => (a.createdSec - b.createdSec) || (a.number - b.number));
  } else {
    items.sort((a, b) => a.number - b.number);
  }
  return items;
}

function pullDiff(repo, pull) {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (baseTip === null || headTip === null) return [];
  return diffCommits(baseTip, headTip);
}

// ------------------------------------------------------------------ schema

class GqlError extends Error {}

const SCHEMA = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User', resolve: () => wrapUser(VIEWER_LOGIN) },
      repository: {
        type: 'Repository',
        resolve: (_parent, args) => {
          const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? getRepo(args.owner, args.name) : null;
          return repo === null ? null : wrapRepo(repo);
        },
      },
      node: {
        type: 'Node',
        resolve: (_parent, args) => resolveNode(args.id),
      },
      __type: {
        type: '__Type',
        resolve: (_parent, args) => (typeof args.name === 'string' && SCHEMA[args.name] !== undefined ? { __typename: '__Type', name: args.name } : null),
      },
      __schema: {
        type: '__Schema',
        resolve: () => ({ __typename: '__Schema' }),
      },
      rateLimit: { type: 'RateLimit', resolve: () => ({ __typename: 'RateLimit' }) },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        resolve: (_parent, args) => {
          const input = args.input ?? {};
          const repo = repoFromGlobalId(input.repositoryId);
          if (repo === null) throw new GqlError('repository not found');
          const issue = newIssueRecord(repo, { title: input.title ?? '', body: input.body ?? '', labels: [] });
          return { __typename: 'CreateIssuePayload', clientMutationId: input.clientMutationId ?? null, issue: wrapIssue(repo, issue) };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        resolve: (_parent, args) => {
          const input = args.input ?? {};
          const found = issueFromGlobalId(input.issueId);
          if (found === null) throw new GqlError('issue not found');
          found.issue.state = 'closed';
          found.issue.closedSec = tickSec();
          found.issue.updatedSec = found.issue.closedSec;
          return { __typename: 'CloseIssuePayload', clientMutationId: input.clientMutationId ?? null, issue: wrapIssue(found.repo, found.issue) };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        resolve: (_parent, args) => {
          const input = args.input ?? {};
          const repo = repoFromGlobalId(input.repositoryId);
          if (repo === null) throw new GqlError('repository not found');
          const head = stripOwnerPrefix(input.headRefName ?? '');
          const base = stripOwnerPrefix(input.baseRefName ?? '');
          if (branchTip(repo, head) === null) throw new GqlError(`head branch ${head} does not exist`);
          if (branchTip(repo, base) === null) throw new GqlError(`base branch ${base} does not exist`);
          const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head === head && p.base === base);
          const pull = existing ?? newPullRecord(repo, { title: input.title ?? '', body: input.body ?? '', head, base });
          return { __typename: 'CreatePullRequestPayload', clientMutationId: input.clientMutationId ?? null, pullRequest: wrapPull(repo, pull) };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        resolve: (_parent, args) => {
          const input = args.input ?? {};
          const found = pullFromGlobalId(input.pullRequestId);
          if (found === null) throw new GqlError('pull request not found');
          const method = typeof input.mergeMethod === 'string' && input.mergeMethod.toLowerCase() === 'merge' ? 'merge' : 'squash';
          const result = performMerge(found.repo, found.pull, method);
          if (!result.ok) throw new GqlError(result.conflict ? 'merge conflict' : (result.reason ?? 'merge failed'));
          return { __typename: 'MergePullRequestPayload', clientMutationId: input.clientMutationId ?? null, pullRequest: wrapPull(found.repo, found.pull) };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        resolve: (_parent, args) => {
          const input = args.input ?? {};
          const found = issueFromGlobalId(input.subjectId) ?? pullSubjectFromGlobalId(input.subjectId);
          if (found === null) throw new GqlError('subject not found');
          const comment = newCommentRecord({ body: input.body ?? '' });
          found.issue.comments.push(comment);
          return {
            __typename: 'AddCommentPayload',
            clientMutationId: input.clientMutationId ?? null,
            commentEdge: { __typename: 'IssueCommentEdge', node: wrapComment(found.repo, found.issue, comment), cursor: cursorOf(comment.id) },
          };
        },
      },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      login: { type: 'String', resolve: (user) => user.login },
      id: { type: 'ID', resolve: (user) => globalId('User', user.login === VIEWER_LOGIN ? VIEWER_ID : 0) },
      databaseId: { type: 'Int', resolve: (user) => (user.login === VIEWER_LOGIN ? VIEWER_ID : 0) },
      name: { type: 'String', resolve: (user) => (user.login === VIEWER_LOGIN ? 'ada iversen' : user.login) },
      email: { type: 'String', resolve: (user) => `${user.login}@example.invalid` },
      url: { type: 'String', resolve: (user) => `/${user.login}` },
      resourcePath: { type: 'String', resolve: (user) => `/${user.login}` },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (w) => repoGlobalId(w.repo) },
      databaseId: { type: 'Int', resolve: (w) => w.repo.id },
      name: { type: 'String', resolve: (w) => w.repo.name },
      nameWithOwner: { type: 'String', resolve: (w) => `${w.repo.owner}/${w.repo.name}` },
      owner: { type: 'User', resolve: (w) => wrapUser(w.repo.owner) },
      description: { type: 'String', resolve: (w) => w.repo.description === '' ? null : w.repo.description },
      isPrivate: { type: 'Boolean', resolve: (w) => w.repo.private },
      viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      hasProjectsEnabled: { type: 'Boolean', resolve: () => false },
      hasWikiEnabled: { type: 'Boolean', resolve: () => false },
      isFork: { type: 'Boolean', resolve: () => false },
      forkCount: { type: 'Int', resolve: () => 0 },
      stargazerCount: { type: 'Int', resolve: () => 0 },
      createdAt: { type: 'String', resolve: (w) => isoOf(w.repo.createdSec) },
      updatedAt: { type: 'String', resolve: (w) => isoOf(w.repo.createdSec) },
      url: { type: 'String', resolve: (w) => `/${w.repo.owner}/${w.repo.name}` },
      resourcePath: { type: 'String', resolve: (w) => `/${w.repo.owner}/${w.repo.name}` },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (w) => {
          const tip = branchTip(w.repo, w.repo.defaultBranch);
          return tip === null ? null : wrapRef(w.repo, w.repo.defaultBranch, tip);
        },
      },
      issue: {
        type: 'Issue',
        resolve: (w, args) => {
          const issue = w.repo.issues.get(Number(args.number));
          return issue === undefined ? null : wrapIssue(w.repo, issue);
        },
      },
      issues: {
        type: 'IssueConnection',
        resolve: (w, args) => {
          const connection = pageOf(repoIssuesOrdered(w.repo, args), args, (issue) => wrapIssue(w.repo, issue));
          connection.__typename = 'IssueConnection';
          return connection;
        },
      },
      pullRequest: {
        type: 'PullRequest',
        resolve: (w, args) => {
          const pull = w.repo.pulls.get(Number(args.number));
          return pull === undefined ? null : wrapPull(w.repo, pull);
        },
      },
      pullRequests: {
        type: 'PullRequestConnection',
        resolve: (w, args) => {
          let items = [...w.repo.pulls.values()];
          if (Array.isArray(args.states) && args.states.length > 0) {
            const wanted = new Set(args.states.map((s) => String(s).toUpperCase()));
            items = items.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          items.sort((a, b) => a.number - b.number);
          const connection = pageOf(items, args, (pull) => wrapPull(w.repo, pull));
          connection.__typename = 'PullRequestConnection';
          return connection;
        },
      },
      ref: {
        type: 'Ref',
        resolve: (w, args) => {
          const qualified = String(args.qualifiedName ?? '');
          const branch = qualified.startsWith('refs/heads/') ? qualified.slice('refs/heads/'.length) : qualified;
          const tip = branchTip(w.repo, branch);
          return tip === null ? null : wrapRef(w.repo, branch, tip);
        },
      },
      labels: {
        type: 'LabelConnection',
        resolve: (w) => ({
          __typename: 'LabelConnection',
          nodes: [...w.repo.labels.values()].map((label) => ({ __typename: 'Label', name: label.name, color: label.color, description: label.description })),
          totalCount: w.repo.labels.size,
        }),
      },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (w) => w.name },
      prefix: { type: 'String', resolve: () => 'refs/heads/' },
      target: { type: 'Commit', resolve: (w) => wrapCommit(w.oid) },
      repository: { type: 'Repository', resolve: (w) => wrapRepo(w.repo) },
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      oid: { type: 'String', resolve: (w) => w.oid },
      id: { type: 'ID', resolve: (w) => globalId('Commit', w.oid) },
      message: { type: 'String', resolve: (w) => parseCommit(getObject(w.oid).data).message },
      committedDate: {
        type: 'String',
        resolve: (w) => isoOf(parseCommit(getObject(w.oid).data).time),
      },
      tree: { type: 'String', resolve: (w) => parseCommit(getObject(w.oid).data).tree },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (w) => issueGlobalId(w.repo, w.issue) },
      databaseId: { type: 'Int', resolve: (w) => w.issue.dbId },
      number: { type: 'Int', resolve: (w) => w.issue.number },
      title: { type: 'String', resolve: (w) => w.issue.title },
      body: { type: 'String', resolve: (w) => w.issue.body },
      bodyText: { type: 'String', resolve: (w) => w.issue.body },
      state: { type: 'String', resolve: (w) => w.issue.state.toUpperCase() },
      closedAt: { type: 'String', resolve: (w) => (w.issue.closedSec === null ? null : isoOf(w.issue.closedSec)) },
      createdAt: { type: 'String', resolve: (w) => isoOf(w.issue.createdSec) },
      updatedAt: { type: 'String', resolve: (w) => isoOf(w.issue.updatedSec) },
      author: { type: 'User', resolve: () => wrapUser(VIEWER_LOGIN) },
      repository: { type: 'Repository', resolve: (w) => wrapRepo(w.repo) },
      url: { type: 'String', resolve: (w) => `/${w.repo.owner}/${w.repo.name}/issues/${w.issue.number}` },
      resourcePath: { type: 'String', resolve: (w) => `/${w.repo.owner}/${w.repo.name}/issues/${w.issue.number}` },
      labels: {
        type: 'LabelConnection',
        resolve: (w) => ({
          __typename: 'LabelConnection',
          nodes: w.issue.labels.map((name) => {
            const label = w.repo.labels.get(name);
            return { __typename: 'Label', name, color: label?.color ?? '000000', description: label?.description ?? '' };
          }),
          totalCount: w.issue.labels.length,
        }),
      },
      comments: {
        type: 'IssueCommentConnection',
        resolve: (w, args) => {
          const first = typeof args.first === 'number' ? args.first : 30;
          const nodes = w.issue.comments.slice(0, first).map((comment) => wrapComment(w.repo, w.issue, comment));
          return {
            __typename: 'IssueCommentConnection',
            nodes,
            totalCount: w.issue.comments.length,
            pageInfo: { __typename: 'PageInfo', hasNextPage: w.issue.comments.length > nodes.length, hasPreviousPage: false, endCursor: null, startCursor: null },
          };
        },
      },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (w) => pullGlobalId(w.repo, w.pull) },
      databaseId: { type: 'Int', resolve: (w) => w.pull.dbId },
      number: { type: 'Int', resolve: (w) => w.pull.number },
      title: { type: 'String', resolve: (w) => w.pull.title },
      body: { type: 'String', resolve: (w) => w.pull.body },
      bodyText: { type: 'String', resolve: (w) => w.pull.body },
      state: { type: 'String', resolve: (w) => (w.pull.merged ? 'MERGED' : w.pull.state.toUpperCase()) },
      merged: { type: 'Boolean', resolve: (w) => w.pull.merged },
      mergedAt: { type: 'String', resolve: (w) => (w.pull.mergedSec === null ? null : isoOf(w.pull.mergedSec)) },
      closedAt: { type: 'String', resolve: (w) => (w.pull.state === 'closed' ? isoOf(w.pull.updatedSec) : null) },
      createdAt: { type: 'String', resolve: (w) => isoOf(w.pull.createdSec) },
      updatedAt: { type: 'String', resolve: (w) => isoOf(w.pull.updatedSec) },
      headRefName: { type: 'String', resolve: (w) => w.pull.head },
      baseRefName: { type: 'String', resolve: (w) => w.pull.base },
      headRef: {
        type: 'Ref',
        resolve: (w) => {
          const tip = branchTip(w.repo, w.pull.head);
          return tip === null ? null : wrapRef(w.repo, w.pull.head, tip);
        },
      },
      baseRef: {
        type: 'Ref',
        resolve: (w) => {
          const tip = branchTip(w.repo, w.pull.base);
          return tip === null ? null : wrapRef(w.repo, w.pull.base, tip);
        },
      },
      mergeable: {
        type: 'String',
        resolve: (w) => {
          if (w.pull.merged) return 'UNKNOWN';
          const baseTip = branchTip(w.repo, w.pull.base);
          const headTip = branchTip(w.repo, w.pull.head);
          if (baseTip === null || headTip === null) return 'UNKNOWN';
          return wouldConflict(baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
        },
      },
      mergeCommit: { type: 'Commit', resolve: (w) => (w.pull.mergeCommitSha === null ? null : wrapCommit(w.pull.mergeCommitSha)) },
      author: { type: 'User', resolve: () => wrapUser(VIEWER_LOGIN) },
      repository: { type: 'Repository', resolve: (w) => wrapRepo(w.repo) },
      url: { type: 'String', resolve: (w) => `/${w.repo.owner}/${w.repo.name}/pull/${w.pull.number}` },
      resourcePath: { type: 'String', resolve: (w) => `/${w.repo.owner}/${w.repo.name}/pull/${w.pull.number}` },
      additions: { type: 'Int', resolve: (w) => pullDiff(w.repo, w.pull).length },
      deletions: { type: 'Int', resolve: () => 0 },
      changedFiles: { type: 'Int', resolve: (w) => pullDiff(w.repo, w.pull).length },
      files: {
        type: 'PullRequestChangedFileConnection',
        resolve: (w, args) => {
          const first = typeof args.first === 'number' ? args.first : 30;
          const diff = pullDiff(w.repo, w.pull);
          const nodes = diff.slice(0, first).map((entry) => ({
            __typename: 'PullRequestChangedFile',
            path: entry.path,
            additions: 0,
            deletions: 0,
            changeType: entry.status.toUpperCase(),
          }));
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes,
            totalCount: diff.length,
            pageInfo: { __typename: 'PageInfo', hasNextPage: diff.length > nodes.length, hasPreviousPage: false, endCursor: null, startCursor: null },
          };
        },
      },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String', resolve: (w) => w.path },
      additions: { type: 'Int', resolve: (w) => w.additions },
      deletions: { type: 'Int', resolve: (w) => w.deletions },
      changeType: { type: 'String', resolve: (w) => w.changeType },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (w) => commentGlobalId(w.comment) },
      databaseId: { type: 'Int', resolve: (w) => w.comment.id },
      body: { type: 'String', resolve: (w) => w.comment.body },
      bodyText: { type: 'String', resolve: (w) => w.comment.body },
      createdAt: { type: 'String', resolve: (w) => isoOf(w.comment.createdSec) },
      updatedAt: { type: 'String', resolve: (w) => isoOf(w.comment.updatedSec) },
      author: { type: 'User', resolve: () => wrapUser(VIEWER_LOGIN) },
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (w) => globalId('Label', w.name) },
      name: { type: 'String', resolve: (w) => w.name },
      color: { type: 'String', resolve: (w) => w.color },
      description: { type: 'String', resolve: (w) => w.description },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean', resolve: (w) => w.hasNextPage },
      hasPreviousPage: { type: 'Boolean', resolve: (w) => w.hasPreviousPage },
      endCursor: { type: 'String', resolve: (w) => w.endCursor },
      startCursor: { type: 'String', resolve: (w) => w.startCursor },
    },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: {
      limit: { type: 'Int', resolve: () => 5000 },
      cost: { type: 'Int', resolve: () => 1 },
      remaining: { type: 'Int', resolve: () => 4999 },
      resetAt: { type: 'String', resolve: () => isoOf(1735689600 + 3600) },
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      types: { type: '[__Type]', resolve: () => Object.keys(SCHEMA).filter((n) => !n.startsWith('__')).map((name) => ({ __typename: '__Type', name })) },
      queryType: { type: '__Type', resolve: () => ({ __typename: '__Type', name: 'Query' }) },
      mutationType: { type: '__Type', resolve: () => ({ __typename: '__Type', name: 'Mutation' }) },
      directives: { type: '[__Directive]', resolve: () => [] },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (w) => w.name },
      kind: { type: 'String', resolve: (w) => SCHEMA[w.name]?.kind ?? 'OBJECT' },
      description: { type: 'String', resolve: () => null },
      fields: {
        type: '[__Field]',
        resolve: (w) => {
          const type = SCHEMA[w.name];
          if (type === undefined || type.kind !== 'OBJECT') return null;
          return Object.entries(type.fields).map(([name, def]) => ({ __typename: '__Field', name, typeName: def.type }));
        },
      },
      enumValues: {
        type: '[__EnumValue]',
        resolve: (w) => {
          const type = SCHEMA[w.name];
          if (type === undefined || type.kind !== 'ENUM') return null;
          return type.values.map((name) => ({ __typename: '__EnumValue', name }));
        },
      },
      possibleTypes: { type: '[__Type]', resolve: () => null },
      inputFields: { type: '[__InputValue]', resolve: () => null },
      specifiedByURL: { type: 'String', resolve: () => null },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (w) => w.name },
      description: { type: 'String', resolve: () => null },
      isDeprecated: { type: 'Boolean', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
      type: { type: '__Type', resolve: (w) => ({ __typename: '__Type', name: w.typeName }) },
      args: { type: '[__InputValue]', resolve: () => [] },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (w) => w.name },
      description: { type: 'String', resolve: () => null },
      isDeprecated: { type: 'Boolean', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: { type: 'Issue', resolve: (w) => w.issue },
      clientMutationId: { type: 'String', resolve: (w) => w.clientMutationId },
    },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: { type: 'Issue', resolve: (w) => w.issue },
      clientMutationId: { type: 'String', resolve: (w) => w.clientMutationId },
    },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (w) => w.pullRequest },
      clientMutationId: { type: 'String', resolve: (w) => w.clientMutationId },
    },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (w) => w.pullRequest },
      clientMutationId: { type: 'String', resolve: (w) => w.clientMutationId },
    },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: { type: 'IssueCommentEdge', resolve: (w) => w.commentEdge },
      clientMutationId: { type: 'String', resolve: (w) => w.clientMutationId },
    },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'IssueComment', resolve: (w) => w.node },
      cursor: { type: 'String', resolve: (w) => w.cursor },
    },
  },
};

// Connections share one shape; register them against the generic wrapper.
for (const connectionName of ['IssueConnection', 'PullRequestConnection', 'LabelConnection', 'IssueCommentConnection', 'PullRequestChangedFileConnection']) {
  SCHEMA[connectionName] = {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Node]', resolve: (w) => w.nodes },
      edges: { type: '[Edge]', resolve: (w) => (w.edges ?? []).map((edge) => ({ __typename: 'Edge', node: edge.node, cursor: edge.cursor })) },
      pageInfo: { type: 'PageInfo', resolve: (w) => w.pageInfo ?? { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null } },
      totalCount: { type: 'Int', resolve: (w) => w.totalCount ?? (w.nodes ? w.nodes.length : 0) },
    },
  };
}
SCHEMA.Edge = {
  kind: 'OBJECT',
  fields: {
    node: { type: 'Node', resolve: (w) => w.node },
    cursor: { type: 'String', resolve: (w) => w.cursor },
  },
};

// Enums the introspection checks name.
SCHEMA.IssueState = { kind: 'ENUM', values: ['OPEN', 'CLOSED'] };
SCHEMA.PullRequestState = { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] };
SCHEMA.MergeableState = { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] };
SCHEMA.RepositoryPermission = { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] };
SCHEMA.IssueOrderField = { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] };
SCHEMA.OrderDirection = { kind: 'ENUM', values: ['ASC', 'DESC'] };
SCHEMA.PullRequestMergeMethod = { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] };
SCHEMA.SearchType = { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] };
SCHEMA.FileChangeType = { kind: 'ENUM', values: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'] };

// ------------------------------------------------------------------ id resolution

function stripOwnerPrefix(ref) {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function repoFromGlobalId(id) {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  return findRepoByDbId(Number(parsed.parts[0]));
}

function issueFromGlobalId(id) {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const repo = findRepoByDbId(Number(parsed.parts[0]));
  if (repo === null) return null;
  const issue = repo.issues.get(Number(parsed.parts[1]));
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(id) {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const repo = findRepoByDbId(Number(parsed.parts[0]));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number(parsed.parts[1]));
  return pull === undefined ? null : { repo, pull };
}

function pullSubjectFromGlobalId(id) {
  const found = pullFromGlobalId(id);
  if (found === null) return null;
  // Comments on a pull request live on the pull record (issue-shaped here).
  return { repo: found.repo, issue: found.pull };
}

function resolveNode(id) {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = findRepoByDbId(Number(parsed.parts[0]));
    return repo === null ? null : wrapRepo(repo);
  }
  if (parsed.kind === 'Issue') {
    const found = issueFromGlobalId(id);
    return found === null ? null : wrapIssue(found.repo, found.issue);
  }
  if (parsed.kind === 'PullRequest') {
    const found = pullFromGlobalId(id);
    return found === null ? null : wrapPull(found.repo, found.pull);
  }
  if (parsed.kind === 'User') return wrapUser(VIEWER_LOGIN);
  return null;
}

// ------------------------------------------------------------------ executor

function resolveField(typeName, parent, field, ctx, errors, path) {
  if (field.name === '__typename') return typeName;
  const type = SCHEMA[typeName];
  const def = type !== undefined && type.kind === 'OBJECT' ? type.fields[field.name] : undefined;
  if (def === undefined) {
    errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'`, path });
    return null;
  }
  const args = {};
  for (const [name, valueNode] of Object.entries(field.args)) args[name] = evalValue(valueNode, ctx.variables);
  let value;
  try {
    value = def.resolve(parent, args, ctx);
  } catch (error) {
    if (error instanceof GqlError) {
      errors.push({ message: error.message, path });
      return null;
    }
    throw error;
  }
  if (value === null || value === undefined) return null;
  if (field.selectionSet === null) return value;
  return completeValue(def.type, value, field.selectionSet, ctx, errors, path);
}

function completeValue(typeName, value, selectionSet, ctx, errors, path) {
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(typeName, item, selectionSet, ctx, errors, [...path, index]));
  }
  if (value === null || typeof value !== 'object') return value;
  const runtimeType = value.__typename ?? typeName;
  return executeSelectionSet(runtimeType, value, selectionSet, ctx, errors, path);
}

function executeSelectionSet(typeName, parent, selections, ctx, errors, path) {
  const out = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      out[key] = resolveField(typeName, parent, selection, ctx, errors, [...path, key]);
    } else if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(typeName, parent, selection.selectionSet, ctx, errors, path));
      }
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSelectionSet(typeName, parent, fragment.selectionSet, ctx, errors, path));
      }
    }
  }
  return out;
}

/** Execute one operation document; returns { data, errors? }. */
export function executeGraphQL(body) {
  const query = typeof body?.query === 'string' ? body.query : '';
  const variables = {};
  if (body !== null && typeof body === 'object' && body.variables !== null && typeof body.variables === 'object') {
    Object.assign(variables, body.variables);
  }
  let document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  let operation = document.operations[0];
  if (typeof body?.operationName === 'string') {
    operation = document.operations.find((op) => op.name === body.operationName) ?? operation;
  }
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  for (const [name, def] of Object.entries(operation.varDefs)) {
    if (variables[name] === undefined && def.defaultValue !== undefined) {
      variables[name] = evalValue(def.defaultValue, variables);
    }
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const errors = [];
  const ctx = { variables, fragments: document.fragments };
  const data = executeSelectionSet(rootType, {}, operation.selectionSet, ctx, errors, []);
  const result = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}
