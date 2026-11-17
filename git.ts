// core-forge's git smart-HTTP surface: ref advertisement (protocol v0 and v2), v2 ls-refs
// and fetch, v0 upload-pack, and receive-pack pushes. Packs are built from the object store
// with no delta compression (valid, if not minimal), and incoming packs are read with full
// OFS_DELTA / REF_DELTA resolution. Ref updates enforce fast-forward-only, per ref, and the
// report-status stream says ok/ng per ref exactly as git's does.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { forge, VIEWER, type ObjType, type RepoRec } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'core-forge/1.0';

// ---------------------------------------------------------------------------------------------
// pkt-line framing

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Decode as many pkt-lines as `buf` holds; returns the packets and the unconsumed rest. */
export function decodePkts(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const lenText = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: buf.subarray(i) };
}

function lines(packets: Packet[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
}

// ---------------------------------------------------------------------------------------------
// packfiles

const TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_IDS[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A valid pack of the given objects, each stored whole (no deltas). */
export function buildPack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface PackEntry {
  offset: number;
  type: ObjType;
  data: Buffer;
  sha: string;
}

/** Read a pack into the store (resolving deltas, including thin-pack bases from the store). */
export function readPackIntoStore(pack: Buffer): number {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, PackEntry>();
  const pending: { offset: number; baseOffset?: number; baseSha?: string; delta: Buffer }[] = [];
  const storeEntry = (type: ObjType, data: Buffer): PackEntry => {
    const sha = forge.store.write(type, data);
    return { offset: 0, type, data, sha };
  };
  for (let n = 0; n < count; n++) {
    const entryOffset = offset;
    let byte = pack[offset++] as number;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++] as number;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (typeId === 6) {
      // OFS_DELTA
      let b = pack[offset++] as number;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++] as number;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeId === 7) {
      // REF_DELTA
      baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    if (typeId === 6 || typeId === 7) {
      pending.push({ offset: entryOffset, baseOffset, baseSha, delta: inflated.data });
    } else {
      const type = ID_TYPES[typeId];
      if (!type) throw new Error(`unknown pack object type ${typeId}`);
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      const entry = storeEntry(type, inflated.data);
      entry.offset = entryOffset;
      byOffset.set(entryOffset, entry);
    }
  }
  // Resolve deltas (possibly chained).
  let guard = 0;
  while (pending.length > 0 && guard++ < 10000) {
    const item = pending.shift() as { offset: number; baseOffset?: number; baseSha?: string; delta: Buffer };
    let base: { type: ObjType; data: Buffer } | undefined;
    if (item.baseOffset !== undefined) {
      const found = byOffset.get(item.baseOffset);
      if (found) base = found;
    } else if (item.baseSha !== undefined) {
      base = forge.store.read(item.baseSha);
      if (!base) {
        // maybe resolved earlier in this same pack under a different offset entry
        for (const e of byOffset.values()) if (e.sha === item.baseSha) base = e;
      }
    }
    if (!base) {
      pending.push(item);
      if (guard > pending.length * 2 + 100) throw new Error('delta base not found');
      continue;
    }
    const data = applyDelta(base.data, item.delta);
    const entry = storeEntry(base.type, data);
    entry.offset = item.offset;
    byOffset.set(item.offset, entry);
  }
  if (pending.length > 0) throw new Error('unresolved pack deltas');
  return byOffset.size;
}

// ---------------------------------------------------------------------------------------------
// object selection for fetch

interface Selection {
  objects: Map<string, { type: ObjType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/** The full object closure of a starting object (commit/tag/tree/blob). */
function closureOf(start: string, into: Map<string, { type: ObjType; data: Buffer }>): void {
  const stack = [start];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (into.has(sha)) continue;
    const obj = forge.store.read(sha);
    if (!obj) continue;
    into.set(sha, obj);
    if (obj.type === 'commit') {
      const info = forge.store.parseCommit(obj.data);
      stack.push(info.tree, ...info.parents);
    } else if (obj.type === 'tree') {
      for (const e of forge.store.parseTree(obj.data)) stack.push(e.sha);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) stack.push(m[1] as string);
    }
  }
}

/**
 * Objects to send for `wants`: full closure minus the closure of `haves`; when `depth` is set,
 * commits are limited to that many generations and the cut commits are reported as shallow.
 */
function selectObjects(wants: string[], haves: string[], depth: number | undefined, clientShallow: string[], deepenNot: string[]): Selection {
  const exclude = new Map<string, { type: ObjType; data: Buffer }>();
  for (const have of haves) closureOf(have, exclude);
  for (const not of deepenNot) closureOf(not, exclude);

  const objects = new Map<string, { type: ObjType; data: Buffer }>();
  const shallow: string[] = [];
  const unshallow: string[] = [];

  // Peel tag wants to commits for generation counting; the tag objects ride along via closure.
  const extraStarts: string[] = [];
  const commitTips: string[] = [];
  for (const want of wants) {
    let cur = want;
    for (;;) {
      const obj = forge.store.read(cur);
      if (!obj) break;
      if (obj.type === 'tag') {
        extraStarts.push(cur);
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (!m) break;
        cur = m[1] as string;
        continue;
      }
      break;
    }
    const obj = forge.store.read(cur);
    if (obj?.type === 'commit') commitTips.push(cur);
    else if (obj) extraStarts.push(cur);
  }

  if (depth === undefined) {
    for (const tip of commitTips) closureOf(tip, objects);
  } else {
    // BFS by generation from the tips.
    const gen = new Map<string, number>();
    let frontier = [...new Set(commitTips)];
    for (const tip of frontier) gen.set(tip, 0);
    for (let g = 0; g < depth && frontier.length > 0; g++) {
      const next: string[] = [];
      for (const sha of frontier) {
        const info = forge.store.commitInfo(sha);
        if (!info) continue;
        closureOfTreeOnly(info.tree, objects);
        const obj = forge.store.read(sha);
        if (obj) objects.set(sha, obj);
        if (g === depth - 1) {
          if (info.parents.length > 0) shallow.push(sha);
        } else {
          for (const parent of info.parents) {
            if (!gen.has(parent)) {
              gen.set(parent, g + 1);
              next.push(parent);
            }
          }
        }
      }
      frontier = next;
    }
    // A commit the client already holds shallow that is now interior becomes unshallow.
    for (const held of clientShallow) {
      const g = gen.get(held);
      if (g !== undefined && g < depth - 1) unshallow.push(held);
    }
  }
  for (const start of extraStarts) closureOf(start, objects);
  for (const sha of exclude.keys()) {
    // Boundary (shallow) commits stay even if a have-closure would drop them: the client
    // asked for the tip itself. Everything else the client provably has is left out.
    if (!shallow.includes(sha)) objects.delete(sha);
  }
  return { objects, shallow, unshallow };
}

function closureOfTreeOnly(treeSha: string, into: Map<string, { type: ObjType; data: Buffer }>): void {
  closureOf(treeSha, into);
}

/** Order objects for a pack: commits, then trees, then blobs, then tags. */
function orderedObjects(objects: Map<string, { type: ObjType; data: Buffer }>): { type: ObjType; data: Buffer }[] {
  const rank: Record<ObjType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  return [...objects.values()].sort((a, b) => rank[a.type] - rank[b.type]);
}

/** Wrap pack bytes in sideband-64k band-1 packets. */
function sidebandPackets(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX = 65519;
  for (let i = 0; i < pack.length; i += MAX) {
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + MAX)])));
  }
  if (chunks.length === 0) chunks.push(pkt(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// refs and advertisement

export function repoRefs(repo: RepoRec): { name: string; sha: string }[] {
  const out = [...repo.refs.entries()].map(([name, sha]) => ({ name, sha }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** The commit a (possibly annotated, possibly nested) tag object peels to, if any. */
export function peelToCommit(sha: string): string | undefined {
  let cur = sha;
  for (let i = 0; i < 16; i++) {
    const obj = forge.store.read(cur);
    if (!obj) return undefined;
    if (obj.type === 'commit') return cur;
    if (obj.type !== 'tag') return undefined;
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!m) return undefined;
    cur = m[1] as string;
  }
  return undefined;
}

function uploadCaps(defaultBranch: string): string {
  return `side-band-64k ofs-delta shallow deepen-since deepen-not object-format=sha1 symref=HEAD:refs/heads/${defaultBranch} agent=${AGENT}`;
}

function receiveCaps(): string {
  return `report-status delete-refs side-band-64k ofs-delta quiet agent=${AGENT}`;
}

function advertisementLines(repo: RepoRec, service: string): { firstCaps: string; refLines: string[] } {
  const caps = service === 'git-receive-pack' ? receiveCaps() : uploadCaps(repo.defaultBranch);
  const refs = repoRefs(repo);
  const lines: string[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip) lines.push(`${headTip} HEAD`);
  for (const ref of refs) {
    lines.push(`${ref.sha} ${ref.name}`);
    const peeled = peelToCommit(ref.sha);
    if (peeled && peeled !== ref.sha) lines.push(`${peeled} ${ref.name}^{}`);
  }
  return { firstCaps: caps, refLines: lines };
}

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitRepo(owner: string, name: string): RepoRec | undefined {
  if (owner !== VIEWER.login) return undefined;
  return forge.getRepo(owner, name);
}

export function handleInfoRefs(owner: string, name: string, service: string, gitProtocol: string | null): GitReply {
  const repo = gitRepo(owner, name);
  if (!repo || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n') };
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const parts = [
      pkt('version 2\n'),
      pkt(`agent=${AGENT}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done\n'),
      pkt('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }
  const { firstCaps, refLines } = advertisementLines(repo, service);
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  if (refLines.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${firstCaps}\n`));
  } else {
    refLines.forEach((line, index) => {
      parts.push(pkt(index === 0 ? `${line}\0${firstCaps}\n` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)

function handleLsRefs(repo: RepoRec, argLines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (keep('HEAD')) {
    if (headTip) {
      out.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (unborn) {
      out.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const ref of repoRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.sha} ${ref.name}`;
    if (peel) {
      const peeled = peelToCommit(ref.sha);
      if (peeled && peeled !== ref.sha) line += ` peeled:${peeled}`;
    }
    out.push(line);
  }
  return Buffer.concat([...out.map((l) => pkt(`${l}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------------------------
// fetch (v0 and v2 share the selection logic)

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth?: number;
  deepenNot: string[];
}

function fetchPack(args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const selection = selectObjects(args.wants, args.haves, args.depth, args.clientShallow, args.deepenNot);
  const pack = buildPack(orderedObjects(selection.objects));
  return { pack, shallow: selection.shallow, unshallow: selection.unshallow };
}

function commonAck(haves: string[]): string | undefined {
  for (const have of haves) {
    if (forge.store.has(have)) return have;
  }
  return undefined;
}

export function handleUploadPack(owner: string, name: string, body: Buffer, gitProtocol: string | null): GitReply {
  const repo = gitRepo(owner, name);
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n') };
  const contentType = 'application/x-git-upload-pack-result';
  const { packets, rest } = decodePkts(body);
  void rest;

  if (gitProtocol === 'version=2') {
    // Header section until delim, then arguments until flush.
    let command = '';
    const argLines: string[] = [];
    let inArgs = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        inArgs = true;
        continue;
      }
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (!inArgs) {
        if (line.startsWith('command=')) command = line.slice('command='.length);
      } else {
        argLines.push(line);
      }
    }
    if (command === 'ls-refs') {
      return { status: 200, contentType, body: handleLsRefs(repo, argLines) };
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], clientShallow: [], deepenNot: [] };
      for (const line of argLines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.clientShallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7).trim(), 10);
        else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice('deepen-not '.length).trim());
      }
      const { pack, shallow, unshallow } = fetchPack(args);
      const parts: Buffer[] = [];
      if (args.haves.length > 0) {
        parts.push(pkt('acknowledgments\n'));
        const ack = commonAck(args.haves);
        if (ack) {
          parts.push(pkt(`ACK ${ack}\n`));
          parts.push(pkt('ready\n'));
        } else {
          parts.push(pkt('NAK\n'));
        }
        parts.push(PKT_DELIM);
      }
      if (shallow.length > 0 || unshallow.length > 0) {
        parts.push(pkt('shallow-info\n'));
        for (const sha of shallow) parts.push(pkt(`shallow ${sha}\n`));
        for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
        parts.push(PKT_DELIM);
      }
      parts.push(pkt('packfile\n'));
      parts.push(sidebandPackets(pack));
      parts.push(PKT_FLUSH);
      return { status: 200, contentType, body: Buffer.concat(parts) };
    }
    return { status: 400, contentType, body: Buffer.from('{"message":"unknown command"}\n') };
  }

  // Protocol v0: want section, flush, have section, flush.
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], deepenNot: [] };
  for (const line of lines(packets)) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) args.clientShallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice('deepen-not '.length).trim());
  }
  const { pack, shallow, unshallow } = fetchPack(args);
  const parts: Buffer[] = [];
  for (const sha of shallow) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  const ack = commonAck(args.haves);
  parts.push(pkt(args.haves.length > 0 && ack ? `ACK ${ack}\n` : 'NAK\n'));
  parts.push(sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack

interface PushOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

export function handleReceivePack(owner: string, name: string, body: Buffer): GitReply {
  const repo = gitRepo(owner, name);
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n') };
  const contentType = 'application/x-git-receive-pack-result';
  // Command pkt-lines run up to the first flush; everything after it is the packfile.
  const packets: Packet[] = [];
  let rest = body;
  {
    let buf = body;
    for (;;) {
      const decoded = decodePkts(buf);
      const first = decoded.packets[0];
      if (!first) break;
      // Recompute the consumed length of exactly one packet.
      const lenText = buf.toString('ascii', 0, 4);
      const len = parseInt(lenText, 16);
      const consumed = len === 0 || len === 1 || len === 2 ? 4 : len;
      packets.push(first);
      buf = buf.subarray(consumed);
      if (first.kind === 'flush') break;
      if (decoded.packets.length === 0) break;
    }
    rest = buf;
  }
  const commandLines = lines(packets);
  let sideband = false;
  let reportStatus = false;
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  commandLines.forEach((raw, index) => {
    let line = raw;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        if (caps.includes('side-band-64k')) sideband = true;
        if (caps.includes('report-status')) reportStatus = true;
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  });

  let unpackError: string | null = null;
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack) {
    if (rest.length === 0) {
      unpackError = 'no packfile sent';
    } else {
      try {
        readPackIntoStore(rest);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }

  const outcomes: PushOutcome[] = [];
  for (const command of commands) {
    if (unpackError) {
      outcomes.push({ ref: command.ref, ok: false, reason: `unpack failed: ${unpackError}` });
      continue;
    }
    outcomes.push(applyPush(repo, command));
  }

  if (!reportStatus) {
    return { status: 200, contentType, body: Buffer.alloc(0) };
  }
  const reportLines: string[] = [unpackError ? `unpack ${unpackError}` : 'unpack ok'];
  for (const outcome of outcomes) {
    reportLines.push(outcome.ok ? `ok ${outcome.ref}` : `ng ${outcome.ref} ${outcome.reason}`);
  }
  const reportStream = Buffer.concat([...reportLines.map((l) => pkt(`${l}\n`)), PKT_FLUSH]);
  if (sideband) {
    const chunks: Buffer[] = [];
    const MAX = 65519;
    for (let i = 0; i < reportStream.length; i += MAX) {
      chunks.push(pkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(i, i + MAX)])));
    }
    chunks.push(PKT_FLUSH);
    return { status: 200, contentType, body: Buffer.concat(chunks) };
  }
  return { status: 200, contentType, body: reportStream };
}

function applyPush(repo: RepoRec, command: { oldOid: string; newOid: string; ref: string }): PushOutcome {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current !== oldOid) {
    return { ref, ok: false, reason: `stale info: expected ${current}` };
  }
  if (newOid === ZERO_OID) {
    // delete
    if (ref === `refs/heads/${repo.defaultBranch}`) return { ref, ok: false, reason: 'deletion of the current branch prohibited' };
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const target = forge.store.read(newOid);
  if (!target) return { ref, ok: false, reason: 'unknown object' };
  if (oldOid !== ZERO_OID) {
    // fast-forward only for branch updates (tags may move in this forge's checks only via delete+create)
    if (ref.startsWith('refs/heads/')) {
      const newCommit = peelToCommit(newOid);
      const oldCommit = peelToCommit(oldOid);
      if (!newCommit || !oldCommit) return { ref, ok: false, reason: 'not a commit' };
      if (!forge.store.ancestors(newCommit).has(oldCommit)) {
        return { ref, ok: false, reason: 'non-fast-forward' };
      }
    }
  }
  repo.refs.set(ref, newOid);
  repo.updatedAt = forge.clock.tick();
  return { ref, ok: true, reason: '' };
}
