// core-forge's HTTP surface: GitHub REST v3 (repositories, contents, branches, commits,
// labels, issues, comments, pull requests, merges), plus the health probe. The git
// smart-HTTP, GraphQL and MCP surfaces live in their own modules and are mounted here.
//
// Determinism: ids and the request-id header come from counters; timestamps come from the
// store's logical clock. Nothing here reads the wall clock or Math.random.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export const forge = new Forge();

type Json = Record<string, unknown>;

function requestId(): string {
  forge.requestSeq += 1;
  return `req-${forge.requestSeq.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(text ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, data: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': data.length, 'x-github-request-id': requestId(), ...headers });
  res.end(data);
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function notFound(message = 'Not Found'): never {
  throw new HttpError(404, message);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): Json {
  if (raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Json;
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

function str(body: Json, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}

function userJson(login: string): Json {
  const known = login === VIEWER.login ? VIEWER : { login, id: 0, name: login, email: `${login}@example.invalid` };
  return { login: known.login, id: known.id, type: 'User', site_admin: false };
}

function repoJson(repo: RepoRec): Json {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `/repos/${repo.owner}/${repo.name}`,
    created_at: forge.clock.iso(repo.createdAt),
    updated_at: forge.clock.iso(repo.updatedAt),
    pushed_at: forge.clock.iso(repo.updatedAt),
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(repo: RepoRec, name: string): Json {
  const label = repo.labels.get(name);
  return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', default: false, description: label?.description ?? null };
}

function issueJson(repo: RepoRec, issue: IssueRec): Json {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(issue.userLogin),
    comments: issue.comments.length,
    created_at: forge.clock.iso(issue.createdAt),
    updated_at: forge.clock.iso(issue.updatedAt),
    closed_at: issue.state === 'closed' ? forge.clock.iso(issue.updatedAt) : null,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: RepoRec, pull: PullRec): Json {
  const headSha = forge.resolveRef(repo, pull.headRef) ?? '';
  const baseSha = forge.resolveRef(repo, pull.baseRef) ?? '';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.userLogin),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo) },
    merged: pull.merged,
    merged_at: pull.mergedAt !== null ? forge.clock.iso(pull.mergedAt) : null,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: forge.clock.iso(pull.createdAt),
    updated_at: forge.clock.iso(pull.updatedAt),
    closed_at: pull.state === 'closed' ? forge.clock.iso(pull.updatedAt) : null,
    html_url: `/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(sha: string): Json {
  const info = forge.store.commitInfo(sha);
  if (!info) return { sha };
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    commit: {
      author: { name: info.authorName, email: info.authorEmail, date: forge.clock.iso(info.authorTs) },
      committer: { name: info.committerName, email: info.committerEmail, date: forge.clock.iso(info.committerTs) },
      message: info.message,
      tree: { sha: info.tree },
    },
    author: userJson(VIEWER.login),
    committer: userJson(VIEWER.login),
    parents: info.parents.map((p) => ({ sha: p })),
  };
}

/** Line-level diff counts and a simple unified patch between two texts. */
function diffLines(oldText: string, newText: string): { additions: number; deletions: number; patch: string } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  let additions = 0;
  let deletions = 0;
  const patchLines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      patchLines.push(` ${a[i]}`);
      i++;
      j++;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      patchLines.push(`-${a[i]}`);
      deletions++;
      i++;
    } else {
      patchLines.push(`+${b[j]}`);
      additions++;
      j++;
    }
  }
  while (i < m) {
    patchLines.push(`-${a[i]}`);
    deletions++;
    i++;
  }
  while (j < n) {
    patchLines.push(`+${b[j]}`);
    additions++;
    j++;
  }
  const patch = `@@ -1,${m} +1,${n} @@\n${patchLines.join('\n')}`;
  return { additions, deletions, patch };
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Json;
  rawBody: Buffer;
}

function requireRepo(owner: string, name: string): RepoRec {
  if (owner !== VIEWER.login) notFound();
  const repo = forge.getRepo(owner, name);
  if (!repo) notFound();
  return repo as RepoRec;
}

function branchTip(repo: RepoRec, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

// ---------------------------------------------------------------------------------------------
// REST handlers

function handleRoot(ctx: Ctx): void {
  sendJson(
    ctx.res,
    200,
    {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      current_user_repositories_url: '/api/v3/user/repos',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function handleUserRepos(ctx: Ctx): void {
  if (ctx.req.method === 'POST') {
    const name = str(ctx.body, 'name');
    if (!name) throw new HttpError(422, 'name is required');
    if (forge.getRepo(VIEWER.login, name)) throw new HttpError(422, 'name already exists on this account');
    const repo = forge.createRepo(VIEWER.login, name, {
      description: str(ctx.body, 'description') ?? '',
      isPrivate: ctx.body.private === true,
      defaultBranch: str(ctx.body, 'default_branch') ?? 'main',
    });
    sendJson(ctx.res, 201, repoJson(repo));
    return;
  }
  const perPage = Math.max(1, Math.min(100, parseInt(ctx.url.searchParams.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.url.searchParams.get('page') ?? '1', 10) || 1);
  const all = forge.viewerRepos();
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const host = ctx.req.headers.host ?? 'localhost';
  const base = `http://${host}/api/v3/user/repos`;
  const links: string[] = [];
  if (page * perPage < all.length) {
    links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
    links.push(`<${base}?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
    links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  }
  if (links.length > 0) headers.link = links.join(', ');
  sendJson(ctx.res, 200, slice.map(repoJson), headers);
}

function handleRepo(ctx: Ctx, owner: string, name: string): void {
  const method = ctx.req.method ?? 'GET';
  if (method === 'DELETE') {
    const repo = requireRepo(owner, name);
    forge.repos.delete(`${repo.owner}/${repo.name}`);
    sendJson(ctx.res, 204, undefined);
    return;
  }
  const repo = requireRepo(owner, name);
  if (method === 'PATCH') {
    const description = str(ctx.body, 'description');
    if (description !== undefined) repo.description = description;
    const priv = ctx.body.private;
    if (typeof priv === 'boolean') repo.isPrivate = priv;
    const newName = str(ctx.body, 'name');
    if (newName && newName !== repo.name) {
      forge.repos.delete(`${repo.owner}/${repo.name}`);
      repo.name = newName;
      forge.repos.set(`${repo.owner}/${repo.name}`, repo);
    }
    repo.updatedAt = forge.clock.tick();
    sendJson(ctx.res, 200, repoJson(repo));
    return;
  }
  sendJson(ctx.res, 200, repoJson(repo));
}

function handleBranches(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(owner, name);
  const out: Json[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(ctx.res, 200, out);
}

function handleCommits(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(owner, name);
  const ref = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = forge.resolveRef(repo, ref);
  if (!tip) {
    sendJson(ctx.res, 200, []);
    return;
  }
  const perPage = Math.max(1, Math.min(100, parseInt(ctx.url.searchParams.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.url.searchParams.get('page') ?? '1', 10) || 1);
  const history = forge.store.history(tip, 10000);
  sendJson(ctx.res, 200, history.slice((page - 1) * perPage, page * perPage).map(commitJson));
}

function handleGitRefs(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(owner, name);
  if (ctx.req.method === 'POST') {
    const ref = str(ctx.body, 'ref');
    const sha = str(ctx.body, 'sha');
    if (!ref || !sha || !forge.store.has(sha)) throw new HttpError(422, 'ref and a known sha are required');
    repo.refs.set(ref, sha);
    sendJson(ctx.res, 201, { ref, object: { sha, type: 'commit' } });
    return;
  }
  notFound();
}

function decodeContent(body: Json): Buffer {
  const content = str(body, 'content');
  if (content === undefined) throw new HttpError(422, 'content is required');
  return Buffer.from(content.replace(/\s+/g, ''), 'base64');
}

function handleContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = requireRepo(owner, name);
  const method = ctx.req.method ?? 'GET';

  if (method === 'PUT') {
    const branch = str(ctx.body, 'branch') ?? repo.defaultBranch;
    const message = str(ctx.body, 'message') ?? 'Update file';
    const content = decodeContent(ctx.body);
    const tip = branchTip(repo, branch);
    const files = tip ? forge.store.filesAt(tip) : new Map<string, { sha: string; mode: string }>();
    const existing = files.get(path);
    const givenSha = str(ctx.body, 'sha');
    if (existing && givenSha !== existing.sha) throw new HttpError(409, 'sha does not match the current file');
    const blobSha = forge.store.writeBlob(content);
    const commit = forge.commitFiles(repo, branch, new Map([[path, content]]), message);
    sendJson(ctx.res, existing ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commit },
    });
    return;
  }

  if (method === 'DELETE') {
    const branch = str(ctx.body, 'branch') ?? repo.defaultBranch;
    const message = str(ctx.body, 'message') ?? 'Delete file';
    const tip = branchTip(repo, branch);
    const files = tip ? forge.store.filesAt(tip) : new Map<string, { sha: string; mode: string }>();
    if (!files.has(path)) notFound();
    const commit = forge.commitFiles(repo, branch, new Map([[path, null]]), message);
    sendJson(ctx.res, 200, { content: null, commit: { sha: commit } });
    return;
  }

  const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
  const tip = forge.resolveRef(repo, ref);
  if (!tip) notFound();
  const info = forge.store.commitInfo(tip as string);
  if (!info) notFound();
  const files = forge.store.filesAt(tip as string);
  const file = files.get(path);
  if (file) {
    const blob = forge.store.read(file.sha);
    const data = blob?.data ?? Buffer.alloc(0);
    sendJson(ctx.res, 200, {
      name: path.split('/').pop(),
      path,
      sha: file.sha,
      size: data.length,
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
    });
    return;
  }
  const sub = forge.store.subTree((info as { tree: string }).tree, path);
  if (sub) {
    const subData = forge.store.read(sub)?.data ?? Buffer.alloc(0);
    const entries = forge.store.parseTree(subData).map((e) => {
      const childPath = path ? `${path}/${e.name}` : e.name;
      const isDir = e.mode === '40000';
      const blob = isDir ? undefined : forge.store.read(e.sha);
      return { name: e.name, path: childPath, sha: e.sha, size: isDir ? 0 : (blob?.data.length ?? 0), type: isDir ? 'dir' : 'file' };
    });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    sendJson(ctx.res, 200, entries);
    return;
  }
  notFound();
}

function handleLabels(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(owner, name);
  if (ctx.req.method === 'POST') {
    const labelName = str(ctx.body, 'name');
    if (!labelName) throw new HttpError(422, 'name is required');
    if (repo.labels.has(labelName)) throw new HttpError(422, 'Validation Failed: label already exists');
    const label = { id: forge.nextLabelId(), name: labelName, color: (str(ctx.body, 'color') ?? 'ededed').replace(/^#/, ''), description: str(ctx.body, 'description') ?? null };
    repo.labels.set(labelName, label);
    sendJson(ctx.res, 201, { id: label.id, name: label.name, color: label.color, default: false, description: label.description });
    return;
  }
  sendJson(ctx.res, 200, [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, default: false, description: l.description })));
}

function validateLabels(repo: RepoRec, names: string[]): void {
  for (const name of names) {
    if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label '${name}' does not exist`);
  }
}

function labelNamesOf(body: Json): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => (typeof l === 'string' ? l : String((l as Json)?.name ?? ''))).filter((s) => s !== '');
}

function handleIssues(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(owner, name);
  if (ctx.req.method === 'POST') {
    const title = str(ctx.body, 'title');
    if (!title) throw new HttpError(422, 'title is required');
    const labels = labelNamesOf(ctx.body);
    validateLabels(repo, labels);
    const ts = forge.clock.tick();
    const issue: IssueRec = {
      id: forge.nextIssueId(),
      number: repo.nextNumber++,
      title,
      body: str(ctx.body, 'body') ?? '',
      state: 'open',
      labels,
      userLogin: VIEWER.login,
      createdAt: ts,
      updatedAt: ts,
      comments: [],
    };
    repo.issues.push(issue);
    sendJson(ctx.res, 201, issueJson(repo, issue));
    return;
  }
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  let list = repo.issues.filter((i) => state === 'all' || i.state === state);
  list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  sendJson(ctx.res, 200, list.map((i) => issueJson(repo, i)));
}

function findIssue(repo: RepoRec, n: number): IssueRec {
  const issue = repo.issues.find((i) => i.number === n);
  if (!issue) notFound();
  return issue as IssueRec;
}

function handleIssue(ctx: Ctx, owner: string, name: string, n: number): void {
  const repo = requireRepo(owner, name);
  const issue = findIssue(repo, n);
  if (ctx.req.method === 'PATCH') {
    const title = str(ctx.body, 'title');
    if (title !== undefined) issue.title = title;
    const bodyText = str(ctx.body, 'body');
    if (bodyText !== undefined) issue.body = bodyText;
    const state = str(ctx.body, 'state');
    if (state === 'open' || state === 'closed') issue.state = state;
    if (Array.isArray(ctx.body.labels)) {
      const labels = labelNamesOf(ctx.body);
      validateLabels(repo, labels);
      issue.labels = labels;
    }
    issue.updatedAt = forge.clock.tick();
  }
  sendJson(ctx.res, 200, issueJson(repo, issue));
}

function handleIssueComments(ctx: Ctx, owner: string, name: string, n: number): void {
  const repo = requireRepo(owner, name);
  const issue = findIssue(repo, n);
  if (ctx.req.method === 'POST') {
    const bodyText = str(ctx.body, 'body');
    if (!bodyText) throw new HttpError(422, 'body is required');
    const ts = forge.clock.tick();
    const comment = { id: forge.nextCommentId(), body: bodyText, userLogin: VIEWER.login, createdAt: ts, updatedAt: ts };
    issue.comments.push(comment);
    issue.updatedAt = ts;
    sendJson(ctx.res, 201, {
      id: comment.id,
      body: comment.body,
      user: userJson(comment.userLogin),
      created_at: forge.clock.iso(comment.createdAt),
      updated_at: forge.clock.iso(comment.updatedAt),
    });
    return;
  }
  sendJson(
    ctx.res,
    200,
    issue.comments.map((c) => ({
      id: c.id,
      body: c.body,
      user: userJson(c.userLogin),
      created_at: forge.clock.iso(c.createdAt),
      updated_at: forge.clock.iso(c.updatedAt),
    })),
  );
}

/** Three-way file merge of head onto base from their merge base; null on conflict. */
function mergeTrees(repo: RepoRec, baseTip: string, headTip: string): Map<string, { sha: string; mode: string }> | null {
  const mb = forge.store.mergeBase(baseTip, headTip);
  const baseFiles = forge.store.filesAt(baseTip);
  const headFiles = forge.store.filesAt(headTip);
  const mbFiles = mb ? forge.store.filesAt(mb) : new Map<string, { sha: string; mode: string }>();
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
      // only base changed it: keep base
    } else {
      return null;
    }
  }
  return out;
}

function handlePulls(ctx: Ctx, owner: string, name: string): void {
  const repo = requireRepo(owner, name);
  if (ctx.req.method === 'POST') {
    const head = str(ctx.body, 'head');
    const base = str(ctx.body, 'base');
    const title = str(ctx.body, 'title');
    if (!head || !base || !title) throw new HttpError(422, 'head, base and title are required');
    const headRef = head.includes(':') ? (head.split(':').pop() as string) : head;
    if (!branchTip(repo, headRef)) throw new HttpError(422, `head branch '${headRef}' does not exist`);
    if (!branchTip(repo, base)) throw new HttpError(422, `base branch '${base}' does not exist`);
    const ts = forge.clock.tick();
    const pull: PullRec = {
      id: forge.nextIssueId(),
      number: repo.nextNumber++,
      title,
      body: str(ctx.body, 'body') ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef: base,
      userLogin: VIEWER.login,
      createdAt: ts,
      updatedAt: ts,
    };
    repo.pulls.push(pull);
    sendJson(ctx.res, 201, pullJson(repo, pull));
    return;
  }
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
  sendJson(ctx.res, 200, list.map((p) => pullJson(repo, p)));
}

function findPull(repo: RepoRec, n: number): PullRec {
  const pull = repo.pulls.find((p) => p.number === n);
  if (!pull) notFound();
  return pull as PullRec;
}

function handlePull(ctx: Ctx, owner: string, name: string, n: number): void {
  const repo = requireRepo(owner, name);
  const pull = findPull(repo, n);
  sendJson(ctx.res, 200, pullJson(repo, pull));
}

function handlePullFiles(ctx: Ctx, owner: string, name: string, n: number): void {
  const repo = requireRepo(owner, name);
  const pull = findPull(repo, n);
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) notFound();
  const mb = forge.store.mergeBase(baseTip, headTip) ?? baseTip;
  const fromFiles = forge.store.filesAt(mb);
  const toFiles = forge.store.filesAt(headTip);
  const paths = new Set([...fromFiles.keys(), ...toFiles.keys()]);
  const out: Json[] = [];
  for (const path of [...paths].sort()) {
    const from = fromFiles.get(path);
    const to = toFiles.get(path);
    if (from?.sha === to?.sha) continue;
    const oldText = from ? (forge.store.read(from.sha)?.data.toString('utf8') ?? '') : '';
    const newText = to ? (forge.store.read(to.sha)?.data.toString('utf8') ?? '') : '';
    const diff = diffLines(oldText, newText);
    out.push({
      sha: to?.sha ?? from?.sha ?? '',
      filename: path,
      status: !from ? 'added' : !to ? 'removed' : 'modified',
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
      patch: diff.patch,
    });
  }
  sendJson(ctx.res, 200, out);
}

function handlePullMerge(ctx: Ctx, owner: string, name: string, n: number): void {
  const repo = requireRepo(owner, name);
  const pull = findPull(repo, n);
  if (pull.merged || pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
  const method = str(ctx.body, 'merge_method') ?? 'merge';
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) throw new HttpError(405, 'Pull Request is not mergeable');
  const merged = mergeTrees(repo, baseTip, headTip);
  if (!merged) throw new HttpError(405, 'Pull Request is not mergeable: merge conflict');
  const tree = forge.store.writeTreeFromFiles(merged);
  const ts = forge.clock.tick();
  let commit: string;
  if (method === 'squash') {
    const message = `${pull.title} (#${pull.number})\n\n${pull.body}`;
    commit = forge.store.writeCommit({ tree, parents: [baseTip], message, ts });
  } else {
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    commit = forge.store.writeCommit({ tree, parents: [baseTip, headTip], message, ts });
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ts;
  pull.mergeCommitSha = commit;
  pull.updatedAt = ts;
  sendJson(ctx.res, 200, { sha: commit, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------------------------
// Routing

async function route(ctx: Ctx): Promise<void> {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  const path = ctx.url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const isApi = path === '/api/v3' || path.startsWith('/api/v3/');
  const isGraphql = path === '/api/graphql';
  const isMcp = path === '/mcp';
  if (isApi || isGraphql || isMcp) {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${TOKEN}`) throw new HttpError(401, 'Bad credentials');
  }

  if (isGraphql || isMcp) {
    notFound();
  }

  if (path === '/api/v3' || path === '/api/v3/') {
    handleRoot(ctx);
    return;
  }
  if (path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '3.10.0' });
    return;
  }
  if (path === '/api/v3/user') {
    sendJson(res, 200, userJson(VIEWER.login));
    return;
  }
  if (path === '/api/v3/rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: 1893456000 } }, rate: { limit: 5000, remaining: 5000, reset: 1893456000 } });
    return;
  }
  if (path === '/api/v3/user/repos') {
    handleUserRepos(ctx);
    return;
  }

  const seg = path.split('/').filter((s) => s !== '');
  if (seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'repos' && seg.length >= 5) {
    const owner = decodeURIComponent(seg[3] as string);
    const name = decodeURIComponent(seg[4] as string);
    const rest = seg.slice(5);
    if (rest.length === 0) {
      handleRepo(ctx, owner, name);
      return;
    }
    if (rest[0] === 'branches' && rest.length === 1) return handleBranches(ctx, owner, name);
    if (rest[0] === 'commits' && rest.length === 1) return handleCommits(ctx, owner, name);
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) return handleGitRefs(ctx, owner, name);
    if (rest[0] === 'contents' && rest.length >= 1) {
      const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      return handleContents(ctx, owner, name, filePath);
    }
    if (rest[0] === 'labels' && rest.length === 1) return handleLabels(ctx, owner, name);
    if (rest[0] === 'issues' && rest.length === 1) return handleIssues(ctx, owner, name);
    if (rest[0] === 'issues' && rest.length === 2) return handleIssue(ctx, owner, name, parseInt(rest[1] as string, 10));
    if (rest[0] === 'issues' && rest.length === 3 && rest[2] === 'comments') return handleIssueComments(ctx, owner, name, parseInt(rest[1] as string, 10));
    if (rest[0] === 'pulls' && rest.length === 1) return handlePulls(ctx, owner, name);
    if (rest[0] === 'pulls' && rest.length === 2) return handlePull(ctx, owner, name, parseInt(rest[1] as string, 10));
    if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'files') return handlePullFiles(ctx, owner, name, parseInt(rest[1] as string, 10));
    if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'merge') return handlePullMerge(ctx, owner, name, parseInt(rest[1] as string, 10));
  }

  notFound();
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const rawBody = await readBody(req);
        const needsJson = rawBody.length > 0 && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE');
        const body = needsJson ? parseJsonBody(rawBody) : {};
        await route({ req, res, url, body, rawBody });
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message });
        } else {
          sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    })();
  });
}

export { sendJson, sendRaw, HttpError, parseJsonBody, readBody };
