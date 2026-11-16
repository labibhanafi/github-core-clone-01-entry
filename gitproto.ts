// gitproto.ts — git smart HTTP for the forge: pkt-line framing, pack reading
// and writing (plain objects out; plain + delta objects in), the v0 and v2
// advertisements, protocol v2 ls-refs and fetch, the v0 fetch fallback, and
// receive-pack pushes with report-status. No git binary anywhere: the object
// store in store.ts is the only state, shared with the REST surface.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  getObject,
  hasObject,
  storeObject,
  parseCommit,
  parseTree,
  parseTag,
  peelToCommit,
  reachableClosure,
  isAncestor,
  sortedRefs,
  branchTip,
} from './store.ts';

export const AGENT = 'forge/1.0.0';

// ------------------------------------------------------------------ pkt-lines

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** One pkt-line: 4 hex digits of total length + payload (string or Buffer). */
export function pkt(payload) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > 65520) throw new Error('pkt-line too large');
  const head = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush() {
  return FLUSH;
}

export function pktDelim() {
  return DELIM;
}

/**
 * Parse a request body into pkt-line tokens. Returns { tokens, rest } where
 * tokens are { kind: 'line', data: Buffer } | { kind: 'flush'|'delim'|'end' }
 * and `rest` is whatever bytes follow the token stream (a push's pack).
 */
export function parsePktLines(buffer) {
  const tokens = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      tokens.push({ kind: 'flush' });
      offset += 4;
      break; // a flush ends the pkt-line stream (a pack may follow)
    }
    if (length === 1) { tokens.push({ kind: 'delim' }); offset += 4; continue; }
    if (length === 2) { tokens.push({ kind: 'end' }); offset += 4; continue; }
    if (length === 3) { tokens.push({ kind: 'delim' }); offset += 4; continue; }
    if (length < 4 || offset + length > buffer.length) break;
    tokens.push({ kind: 'line', data: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { tokens, rest: buffer.subarray(offset) };
}

/** Sideband-wrap a payload: band-1 pkt-lines of at most ~32 KiB each + flush. */
export function sidebandWrap(payload) {
  const chunks = [];
  const CHUNK = 32000;
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    const slice = payload.subarray(offset, Math.min(payload.length, offset + CHUNK));
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (payload.length === 0) {
    chunks.push(pkt(Buffer.from([1])));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ packs

const TYPE_IDS = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_NAMES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

/** Serialize a list of { type, data } objects into a pack (no deltas). */
export function writePack(objects) {
  const parts = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const object of objects) {
    let size = object.data.length;
    const typeId = TYPE_IDS[object.type];
    const bytes = [];
    let first = (size & 0x0f) | (typeId << 4);
    size >>= 4;
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (copy/insert program) to a base object's bytes. */
function applyDelta(base, delta) {
  let offset = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size (trusted)
  const targetSize = readVarint();
  const out = [];
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) { copyOffset |= delta[offset] << (8 * i); offset += 1; }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) { copySize |= delta[offset] << (8 * i); offset += 1; }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta size mismatch');
  return result;
}

/**
 * Parse a pack into the object store. Returns { count } on success; throws on
 * malformed input. The walk records each object's header offset, so OFS
 * deltas find their base by byte distance and REF deltas by oid; resolution
 * then iterates to a fixed point against the store and the pack itself.
 */
export function readPackIntoStore(pack) {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const entries = []; // { index, headerStart, typeName, data?, baseOid?, baseIndex? }
  const indexByOffset = new Map();

  const inflateAt = (start) => {
    const result = inflateSync(pack.subarray(start), { info: true });
    return { data: result.buffer, consumed: result.engine.bytesWritten };
  };

  for (let index = 0; index < count; index += 1) {
    const headerStart = offset;
    indexByOffset.set(headerStart, index);
    let byte = pack[offset];
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const typeName = TYPE_NAMES[typeId];
    if (typeName === undefined) throw new Error(`unknown pack object type ${typeId}`);
    if (typeName === 'ofs-delta') {
      byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      const { data, consumed } = inflateAt(offset);
      offset += consumed;
      entries.push({ index, headerStart, typeName, delta: data, baseOffset: headerStart - back });
    } else if (typeName === 'ref-delta') {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const { data, consumed } = inflateAt(offset);
      offset += consumed;
      entries.push({ index, headerStart, typeName, delta: data, baseOid });
    } else {
      const { data, consumed } = inflateAt(offset);
      offset += consumed;
      if (data.length !== size) throw new Error('pack object size mismatch');
      entries.push({ index, headerStart, typeName, data });
    }
  }

  // Resolve: plain objects first, then deltas whose base is known.
  const oidByIndex = new Map();
  const localByOid = new Map();
  const resolveOne = (entry, type, data) => {
    const oid = storeObject(type, data);
    oidByIndex.set(entry.index, oid);
    localByOid.set(oid, { type, data });
  };
  for (const entry of entries) {
    if (entry.data !== undefined) resolveOne(entry, entry.typeName, entry.data);
  }
  let pending = entries.filter((entry) => entry.data === undefined);
  let guard = 0;
  while (pending.length > 0) {
    guard += 1;
    if (guard > count + 2) throw new Error('pack delta chain too deep');
    const still = [];
    let progressed = false;
    for (const entry of pending) {
      let base = null;
      if (entry.baseOid !== undefined) {
        base = localByOid.get(entry.baseOid) ?? getObject(entry.baseOid);
      } else {
        const baseIndex = indexByOffset.get(entry.baseOffset);
        const baseOid = baseIndex === undefined ? undefined : oidByIndex.get(baseIndex);
        if (baseOid !== undefined) base = localByOid.get(baseOid) ?? getObject(baseOid);
      }
      if (base === null || base === undefined) {
        still.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.delta);
      resolveOne(entry, base.type, data);
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base missing');
    pending = still;
  }
  return { count };
}

// ------------------------------------------------------------------ advertisements

const UPLOAD_CAPS_V0 = (repo) =>
  `side-band-64k ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** The ref lines of an advertisement (HEAD first, then refs, tags peeled). */
function advertisementRefs(repo, service) {
  const lines = [];
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0(repo) : RECEIVE_CAPS;
  const refs = sortedRefs(repo);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  lines.push(pkt(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
  for (const [ref, oid] of refs) {
    lines.push(pkt(`${oid} ${ref}\n`));
    const obj = getObject(oid);
    if (obj !== null && obj.type === 'tag') {
      const commit = peelToCommit(oid);
      if (commit !== null) lines.push(pkt(`${commit} ${ref}^{}\n`));
    }
  }
  return lines;
}

/** GET /info/refs for either service, in the protocol the client asked for. */
export function infoRefs(repo, service, protocolVersion) {
  if (service === 'git-upload-pack' && protocolVersion === 2) {
    const parts = [pkt('# service=git-upload-pack\n'), pktFlush()];
    parts.push(pkt('version 2\n'));
    parts.push(pkt(`agent=${AGENT}\n`));
    parts.push(pkt('ls-refs=unborn\n'));
    parts.push(pkt('fetch=shallow wait-for-done\n'));
    parts.push(pkt('object-format=sha1\n'));
    parts.push(pktFlush());
    return {
      contentType: 'application/x-git-upload-pack-advertisement',
      body: Buffer.concat(parts),
    };
  }
  const parts = [pkt(`# service=${service}\n`), pktFlush(), ...advertisementRefs(repo, service), pktFlush()];
  return {
    contentType: `application/x-${service}-advertisement`,
    body: Buffer.concat(parts),
  };
}

// ------------------------------------------------------------------ ls-refs (v2)

export function handleLsRefs(repo, args) {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(pkt(`${headOid} HEAD${wantSymrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (wantUnborn) {
      lines.push(pkt(`unborn HEAD${wantSymrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const obj = getObject(oid);
    if (wantPeel && obj !== null && obj.type === 'tag') {
      const commit = peelToCommit(oid);
      if (commit !== null) line += ` peeled:${commit}`;
    }
    lines.push(pkt(`${line}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

// ------------------------------------------------------------------ fetch

/**
 * Compute the object set for a fetch: { oids: [...], shallow: [], unshallow: [] }.
 * Depth handling follows the protocol: generations are parent-distance from
 * the wants; boundary commits are reported shallow; a deepen that includes a
 * former boundary's parents unshallows it.
 */
/**
 * The objects a client already holds: the closure of its haves, except that
 * traversal does not cross a shallow boundary — a boundary commit's parents
 * are exactly what the client does NOT have, however reachable they are
 * from the have through the boundary.
 */
function clientHaveSet(haves, shallowClient) {
  const boundary = new Set(shallowClient);
  const seen = new Set();
  const stack = haves.filter((oid) => hasObject(oid));
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === undefined || seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(oid);
    if (obj === null) continue;
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit.tree !== null) stack.push(commit.tree);
      if (!boundary.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag.object !== null) stack.push(tag.object);
    }
  }
  return seen;
}

export function fetchSelection({ wants, haves, shallowClient, deepen, deepenSince, deepenNot }) {
  const validWants = wants.filter((oid) => hasObject(oid));
  const haveClosure = clientHaveSet(haves, shallowClient);
  const shallowMode = deepen !== null || deepenSince !== null || deepenNot.length > 0;

  if (!shallowMode) {
    const wanted = reachableClosure(validWants);
    const oids = [...wanted].filter((oid) => !haveClosure.has(oid));
    return { oids, shallow: [], unshallow: [] };
  }

  // BFS generations (parent distance) from the wants over commits.
  const generation = new Map();
  let frontier = [];
  for (const oid of validWants) {
    const commitOid = peelToCommit(oid);
    if (commitOid !== null && !generation.has(commitOid)) {
      generation.set(commitOid, 0);
      frontier.push(commitOid);
    }
  }
  const notClosure = new Set();
  if (deepenNot.length > 0) {
    for (const oid of reachableClosure(deepenNot.filter((o) => hasObject(o)))) notClosure.add(o);
  }
  const included = new Set();
  while (frontier.length > 0) {
    const next = [];
    for (const oid of frontier) {
      const gen = generation.get(oid);
      const obj = getObject(oid);
      if (obj === null || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      let include = true;
      if (deepen !== null && gen >= deepen) include = false;
      if (deepenSince !== null && commit.time <= deepenSince) include = false;
      if (notClosure.has(oid)) include = false;
      if (!include) continue;
      included.add(oid);
      for (const parent of commit.parents) {
        if (!generation.has(parent)) {
          generation.set(parent, gen + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  // Boundary: an included commit with a parent that exists but is not included.
  const boundary = [];
  for (const oid of included) {
    const commit = parseCommit(getObject(oid).data);
    if (commit.parents.some((parent) => !included.has(parent) && hasObject(parent))) {
      boundary.push(oid);
    }
  }
  const boundarySet = new Set(boundary);
  const shallow = boundary.filter((oid) => !shallowClient.includes(oid));
  const unshallow = shallowClient.filter((oid) => included.has(oid) && !boundarySet.has(oid));
  // Objects: the included commits with their tree closure (trees and blobs
  // only — never their parents, which is the whole point of a shallow cut),
  // minus everything the client already has.
  const closure = new Set();
  const stack = [];
  for (const oid of included) {
    closure.add(oid);
    const commit = parseCommit(getObject(oid).data);
    if (commit.tree !== null) stack.push(commit.tree);
  }
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === undefined || closure.has(oid)) continue;
    const obj = getObject(oid);
    if (obj === null) continue;
    closure.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
  const oids = [...closure].filter((oid) => !haveClosure.has(oid));
  return { oids, shallow, unshallow };
}

/** Order pack objects: commits, trees, blobs, tags (any order verifies). */
function orderObjects(oids) {
  const rank = { commit: 0, tree: 1, blob: 2, tag: 3 };
  return oids
    .map((oid) => getObject(oid))
    .filter((obj) => obj !== null)
    .sort((a, b) => rank[a.type] - rank[b.type])
    .map((obj) => ({ type: obj.type, data: obj.data }));
}

function parseFetchArgs(lines) {
  const parsed = {
    wants: [],
    haves: [],
    shallowClient: [],
    deepen: null,
    deepenSince: null,
    deepenNot: [],
    done: false,
  };
  for (const line of lines) {
    if (line.startsWith('want ')) parsed.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) parsed.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) parsed.shallowClient.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) parsed.deepen = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) parsed.deepenSince = Number(line.slice(13));
    else if (line.startsWith('deepen-not ')) parsed.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') parsed.done = true;
  }
  return parsed;
}

/** POST /git-upload-pack, protocol v2 (command=ls-refs / command=fetch). */
export function handleUploadPackV2(repo, body) {
  const { tokens } = parsePktLines(body);
  const lines = tokens.filter((t) => t.kind === 'line').map((t) => t.data.toString('utf8').replace(/\n$/, ''));
  // Split at the delim: command + capabilities before, arguments after.
  const delimIndex = tokens.findIndex((t) => t.kind === 'delim');
  let argLines;
  if (delimIndex >= 0) {
    const before = tokens.slice(0, delimIndex).filter((t) => t.kind === 'line').length;
    argLines = lines.slice(before);
  } else {
    argLines = lines.slice(1);
  }
  const commandLine = lines[0] ?? '';
  if (commandLine === 'command=ls-refs') {
    return handleLsRefs(repo, argLines);
  }
  if (commandLine === 'command=fetch') {
    const args = parseFetchArgs(argLines);
    const selection = fetchSelection(args);
    const pack = writePack(orderObjects(selection.oids));
    const parts = [];
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    parts.push(pkt('packfile\n'));
    parts.push(sidebandWrap(pack));
    return Buffer.concat(parts);
  }
  // Unknown command: an empty flush answer (the server stays up).
  return pktFlush();
}

/** POST /git-upload-pack, protocol v0. */
export function handleUploadPackV0(repo, body) {
  const { tokens } = parsePktLines(body);
  const lines = tokens.filter((t) => t.kind === 'line').map((t) => t.data.toString('utf8').replace(/\n$/, ''));
  const args = parseFetchArgs(lines.map((line) => {
    // The first want line may carry capabilities after the oid (space form).
    if (line.startsWith('want ')) return `want ${line.slice(5, 45)}`;
    return line;
  }));
  const selection = fetchSelection(args);
  const pack = writePack(orderObjects(selection.oids));
  const parts = [pkt('NAK\n')];
  for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(sidebandWrap(pack));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

/**
 * POST /git-receive-pack: apply a push. Returns the report-status stream
 * (sideband-wrapped). Refs move only on fast-forward; a mixed push applies
 * the refs that pass and reports one line per ref.
 */
export function handleReceivePack(repo, body) {
  const { tokens, rest } = parsePktLines(body);
  const commands = [];
  for (const token of tokens) {
    if (token.kind !== 'line') continue;
    let text = token.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }

  let unpackOk = true;
  let unpackDetail = '';
  if (rest.length > 0) {
    try {
      readPackIntoStore(rest);
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : String(error);
    }
  }

  const reportLines = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    if (!unpackOk) {
      reportLines.push(`ng ${ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(ref) ?? null;
    if (newOid === ZERO_OID) {
      // Delete (delete-refs is advertised; deleting a missing ref is ok).
      repo.refs.delete(ref);
      reportLines.push(`ok ${ref}\n`);
      continue;
    }
    const target = getObject(newOid);
    if (target === null) {
      reportLines.push(`ng ${ref} bad object\n`);
      continue;
    }
    if (current !== null) {
      const currentCommit = peelToCommit(current);
      const newCommit = peelToCommit(newOid);
      if (currentCommit !== null && newCommit !== null && currentCommit !== newCommit && !isAncestor(currentCommit, newCommit)) {
        reportLines.push(`ng ${ref} non-fast-forward\n`);
        continue;
      }
    }
    void oldOid;
    repo.refs.set(ref, newOid);
    reportLines.push(`ok ${ref}\n`);
  }
  const inner = Buffer.concat([...reportLines.map((line) => pkt(line)), pktFlush()]);
  return sidebandWrap(inner);
}

/** Whether a branch ref name is safe to use as a map key / path segment. */
export function refExists(repo, ref) {
  return repo.refs.has(ref);
}

export { branchTip };
