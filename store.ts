// core-forge's store: a git object database (real SHA-1 git objects, so the smart-HTTP
// protocol interoperates with real git clients) plus the forge's own records (repositories,
// issues, pull requests, labels). Everything is in memory and deterministic: ids come from
// counters and timestamps from a logical clock, never from the wall clock or randomness, so
// two runs over the same request sequence produce byte-identical results.

import { createHash } from 'node:crypto';

export const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const STRANGER = { login: 'olgabauer', id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid' };

/** Logical clock: starts at MAKEFUN_TRIAL_NOW when the harness provides it, else a fixed epoch. */
export class Clock {
  private t: number;
  constructor() {
    const now = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = now ? Date.parse(now) : NaN;
    this.t = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1735689600; // 2025-01-01T00:00:00Z
  }
  /** Advance one second and return the new time as epoch seconds. */
  tick(): number {
    this.t += 1;
    return this.t;
  }
  now(): number {
    return this.t;
  }
  iso(sec?: number): string {
    return new Date((sec ?? this.t) * 1000).toISOString().replace(/\.000Z$/, 'Z');
  }
}

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
  message: string;
}

export class ObjectStore {
  private objects = new Map<string, { type: ObjType; data: Buffer }>();

  write(type: ObjType, data: Buffer): string {
    const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const sha = createHash('sha1').update(head).update(data).digest('hex');
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  read(sha: string): { type: ObjType; data: Buffer } | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  allShas(): string[] {
    return [...this.objects.keys()];
  }

  writeBlob(content: Buffer): string {
    return this.write('blob', content);
  }

  /** Build (nested) tree objects from a flat path -> blob map; returns the root tree sha. */
  writeTreeFromFiles(files: Map<string, { sha: string; mode: string }>): string {
    interface Node {
      dirs: Map<string, Node>;
      files: Map<string, { sha: string; mode: string }>;
    }
    const root: Node = { dirs: new Map(), files: new Map() };
    for (const [path, entry] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i] as string;
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: new Map() });
        node = node.dirs.get(part) as Node;
      }
      node.files.set(parts[parts.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: { name: string; mode: string; sha: string; isDir: boolean }[] = [];
      for (const [name, e] of node.files) entries.push({ name, mode: e.mode, sha: e.sha, isDir: false });
      for (const [name, sub] of node.dirs) entries.push({ name, mode: '40000', sha: build(sub), isDir: true });
      // git sorts tree entries by name, directories as if suffixed with '/'
      entries.sort((a, b) => {
        const an = a.isDir ? `${a.name}/` : a.name;
        const bn = b.isDir ? `${b.name}/` : b.name;
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
      const chunks: Buffer[] = [];
      for (const e of entries) {
        chunks.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
        chunks.push(Buffer.from(e.sha, 'hex'));
      }
      return this.write('tree', Buffer.concat(chunks));
    };
    return build(root);
  }

  /** Parse a tree object into entries. */
  parseTree(data: Buffer): { mode: string; name: string; sha: string }[] {
    const out: { mode: string; name: string; sha: string }[] = [];
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      const mode = data.toString('utf8', i, sp);
      const nul = data.indexOf(0x00, sp);
      const name = data.toString('utf8', sp + 1, nul);
      const sha = data.toString('hex', nul + 1, nul + 21);
      out.push({ mode, name, sha });
      i = nul + 21;
    }
    return out;
  }

  /** Flatten a tree into path -> blob entries (recursive). */
  flattenTree(treeSha: string, prefix = ''): Map<string, { sha: string; mode: string }> {
    const out = new Map<string, { sha: string; mode: string }>();
    const entry = this.read(treeSha);
    if (!entry || entry.type !== 'tree') return out;
    for (const e of this.parseTree(entry.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        for (const [p, v] of this.flattenTree(e.sha, path)) out.set(p, v);
      } else {
        out.set(path, { sha: e.sha, mode: e.mode });
      }
    }
    return out;
  }

  /** The tree sha of one subdirectory path inside a tree ('' is the root), or undefined. */
  subTree(treeSha: string, dirPath: string): string | undefined {
    if (dirPath === '') return treeSha;
    let cur = treeSha;
    for (const part of dirPath.split('/')) {
      const entry = this.read(cur);
      if (!entry || entry.type !== 'tree') return undefined;
      const found = this.parseTree(entry.data).find((e) => e.name === part && e.mode === '40000');
      if (!found) return undefined;
      cur = found.sha;
    }
    return cur;
  }

  writeCommit(info: { tree: string; parents: string[]; message: string; ts: number; name?: string; email?: string }): string {
    const name = info.name ?? VIEWER.name;
    const email = info.email ?? VIEWER.email;
    const lines = [`tree ${info.tree}`];
    for (const p of info.parents) lines.push(`parent ${p}`);
    lines.push(`author ${name} <${email}> ${info.ts} +0000`);
    lines.push(`committer ${name} <${email}> ${info.ts} +0000`);
    const data = Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
    return this.write('commit', data);
  }

  parseCommit(data: Buffer): CommitInfo {
    const text = data.toString('utf8');
    const split = text.indexOf('\n\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const message = split >= 0 ? text.slice(split + 2) : '';
    const info: CommitInfo = {
      tree: '',
      parents: [],
      authorName: '',
      authorEmail: '',
      authorTs: 0,
      committerName: '',
      committerEmail: '',
      committerTs: 0,
      message,
    };
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) info.tree = line.slice(5);
      else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
      else if (line.startsWith('author ')) {
        const m = /^(.*) <(.*)> (\d+) /.exec(line.slice(7));
        if (m) {
          info.authorName = m[1] as string;
          info.authorEmail = m[2] as string;
          info.authorTs = parseInt(m[3] as string, 10);
        }
      } else if (line.startsWith('committer ')) {
        const m = /^(.*) <(.*)> (\d+) /.exec(line.slice(10));
        if (m) {
          info.committerName = m[1] as string;
          info.committerEmail = m[2] as string;
          info.committerTs = parseInt(m[3] as string, 10);
        }
      }
    }
    return info;
  }

  commitInfo(sha: string): CommitInfo | undefined {
    const entry = this.read(sha);
    if (!entry || entry.type !== 'commit') return undefined;
    return this.parseCommit(entry.data);
  }

  /** Files at a commit (flattened tree). */
  filesAt(commitSha: string): Map<string, { sha: string; mode: string }> {
    const info = this.commitInfo(commitSha);
    if (!info) return new Map();
    return this.flattenTree(info.tree);
  }

  /** True when `anc` is `desc` itself or one of its ancestors; stops as soon as it is found. */
  isAncestor(anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === anc) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.read(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of this.parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /** All ancestors of a commit (including itself), via BFS over parents. */
  ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const queue = [sha];
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const info = this.commitInfo(cur);
      if (info) queue.push(...info.parents);
    }
    return seen;
  }

  /** The best common ancestor of two commits (first BFS hit from b inside a's ancestor set). */
  mergeBase(a: string, b: string): string | undefined {
    const ancA = this.ancestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (ancA.has(cur)) return cur;
      const info = this.commitInfo(cur);
      if (info) queue.push(...info.parents);
    }
    return undefined;
  }

  /** First-parent history from a tip, newest first. */
  history(tip: string, limit = 1000): string[] {
    const out: string[] = [];
    let cur: string | undefined = tip;
    const seen = new Set<string>();
    while (cur && !seen.has(cur) && out.length < limit) {
      seen.add(cur);
      out.push(cur);
      const info = this.commitInfo(cur);
      cur = info?.parents[0];
    }
    return out;
  }
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  userLogin: string;
  createdAt: number;
  updatedAt: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: number;
  updatedAt: number;
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  userLogin: string;
  createdAt: number;
  updatedAt: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
  refs: Map<string, string>;
  /** Bump on every ref mutation: read caches (ls-refs) key on it. */
  refsVersion: number;
  labels: Map<string, LabelRec>;
  issues: IssueRec[];
  pulls: PullRec[];
  nextNumber: number;
}

/** Set a ref and bump the repo's ref version (the ls-refs cache keys on it). */
export function setRef(repo: RepoRec, ref: string, sha: string): void {
  repo.refs.set(ref, sha);
  repo.refsVersion += 1;
}

/** Delete a ref and bump the repo's ref version when it existed. */
export function deleteRef(repo: RepoRec, ref: string): void {
  if (repo.refs.delete(ref)) repo.refsVersion += 1;
}

export class Forge {
  readonly clock = new Clock();
  readonly store = new ObjectStore();
  readonly repos = new Map<string, RepoRec>(); // key: owner/name (owner is always the viewer in practice)
  private repoIdSeq = 100000;
  private issueIdSeq = 200000;
  private commentIdSeq = 300000;
  private labelIdSeq = 400000;
  requestSeq = 0;

  nextRepoId(): number {
    return this.repoIdSeq++;
  }
  nextIssueId(): number {
    return this.issueIdSeq++;
  }
  nextCommentId(): number {
    return this.commentIdSeq++;
  }
  nextLabelId(): number {
    return this.labelIdSeq++;
  }

  createRepo(owner: string, name: string, opts: { description?: string; isPrivate?: boolean; defaultBranch?: string }): RepoRec {
    const ts = this.clock.tick();
    const repo: RepoRec = {
      id: this.nextRepoId(),
      owner,
      name,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: ts,
      updatedAt: ts,
      refs: new Map(),
      refsVersion: 0,
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  viewerRepos(): RepoRec[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.id - b.id);
  }

  /** The commit sha a ref name (branch, full ref, or sha) resolves to in a repo, or undefined. */
  resolveRef(repo: RepoRec, ref: string): string | undefined {
    if (/^[0-9a-f]{40}$/.test(ref) && this.store.has(ref)) return ref;
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const asBranch = `refs/heads/${ref}`;
    if (repo.refs.has(asBranch)) return repo.refs.get(asBranch);
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return undefined;
  }

  /** Commit files `files` (path -> content|null to delete) onto a branch; returns the new commit sha. */
  commitFiles(repo: RepoRec, branch: string, changes: Map<string, Buffer | null>, message: string): string {
    const refName = `refs/heads/${branch}`;
    const parent = repo.refs.get(refName);
    const files = parent ? this.store.filesAt(parent) : new Map<string, { sha: string; mode: string }>();
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else files.set(path, { sha: this.store.writeBlob(content), mode: '100644' });
    }
    const tree = this.store.writeTreeFromFiles(files);
    const ts = this.clock.tick();
    const commit = this.store.writeCommit({ tree, parents: parent ? [parent] : [], message, ts });
    setRef(repo, refName, commit);
    repo.updatedAt = ts;
    return commit;
  }
}

/** The one forge instance the whole process serves. */
export const forge = new Forge();

/**
 * Three-way file merge of a head commit onto a base commit from their merge base.
 * Returns the merged file map, or null when both sides changed the same file differently.
 */
export function mergeFileMaps(
  store: ObjectStore,
  baseTip: string,
  headTip: string,
): Map<string, { sha: string; mode: string }> | null {
  const mb = store.mergeBase(baseTip, headTip);
  const baseFiles = store.filesAt(baseTip);
  const headFiles = store.filesAt(headTip);
  const mbFiles = mb ? store.filesAt(mb) : new Map<string, { sha: string; mode: string }>();
  const out = new Map(baseFiles);
  const paths = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const inMb = mbFiles.get(path)?.sha;
    const inBase = baseFiles.get(path)?.sha;
    const inHead = headFiles.get(path)?.sha;
    if (inBase === inHead) continue;
    if (inMb === inBase) {
      if (inHead === undefined) out.delete(path);
      else out.set(path, headFiles.get(path) as { sha: string; mode: string });
    } else if (inMb === inHead) {
      // only the base side changed it: keep base
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Merge a pull request into its base branch (squash or merge commit). On success the pull
 * record is updated and the merge commit sha returned; on conflict nothing changes.
 */
export function performMerge(
  forgeRef: Forge,
  repo: RepoRec,
  pull: PullRec,
  method: string,
): { ok: true; sha: string } | { ok: false; reason: string } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { ok: false, reason: 'branch tip missing' };
  const merged = mergeFileMaps(forgeRef.store, baseTip, headTip);
  if (!merged) return { ok: false, reason: 'merge conflict' };
  const tree = forgeRef.store.writeTreeFromFiles(merged);
  const ts = forgeRef.clock.tick();
  let commit: string;
  if (method === 'squash') {
    const message = `${pull.title} (#${pull.number})\n\n${pull.body}`;
    commit = forgeRef.store.writeCommit({ tree, parents: [baseTip], message, ts });
  } else {
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    commit = forgeRef.store.writeCommit({ tree, parents: [baseTip, headTip], message, ts });
  }
  setRef(repo, `refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ts;
  pull.mergeCommitSha = commit;
  pull.updatedAt = ts;
  return { ok: true, sha: commit };
}
