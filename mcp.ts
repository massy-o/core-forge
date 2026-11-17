// core-forge's MCP endpoint: JSON-RPC 2.0 over POST /mcp, speaking both protocol eras —
// the modern `server/discover` revision (2026-07-28) and the legacy `initialize` handshake.
// The tools are github-mcp-server's core set over the same store REST serves, so an object
// created here is the same object REST reads back. Tool results carry the REST-shaped JSON
// as their text content. Stateless: every request answers on its own id.

import { forge, performMerge, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';

type Json = Record<string, unknown>;

const SERVER_INFO = { name: 'core-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'number', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsListResult(): Json {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

// REST-shaped views (kept in step with app.ts so MCP and REST describe the same objects) -------

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

function issueJson(repo: RepoRec, issue: IssueRec): Json {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', default: false, description: label?.description ?? null };
    }),
    user: userJson(issue.userLogin),
    comments: issue.comments.length,
    created_at: forge.clock.iso(issue.createdAt),
    updated_at: forge.clock.iso(issue.updatedAt),
    closed_at: issue.state === 'closed' ? forge.clock.iso(issue.updatedAt) : null,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: RepoRec, pull: PullRec): Json {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.userLogin),
    head: { ref: pull.headRef, sha: forge.resolveRef(repo, pull.headRef) ?? '', label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: forge.resolveRef(repo, pull.baseRef) ?? '', label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo) },
    merged: pull.merged,
    merged_at: pull.mergedAt !== null ? forge.clock.iso(pull.mergedAt) : null,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: forge.clock.iso(pull.createdAt),
    updated_at: forge.clock.iso(pull.updatedAt),
    closed_at: pull.state === 'closed' ? forge.clock.iso(pull.updatedAt) : null,
    html_url: `/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// Tool execution --------------------------------------------------------------------------------

class ToolFailure extends Error {}

function requireRepo(owner: unknown, repo: unknown): RepoRec {
  if (typeof owner !== 'string' || typeof repo !== 'string' || owner !== VIEWER.login) {
    throw new ToolFailure('repository not found');
  }
  const found = forge.getRepo(owner, repo);
  if (!found) throw new ToolFailure('repository not found');
  return found;
}

function runTool(name: string, args: Json): unknown {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return undefined;
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      throw new ToolFailure(`missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.getRepo(VIEWER.login, repoName)) throw new ToolFailure('name already exists on this account');
      const repo = forge.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return repoJson(repo);
    }
    case 'get_repo': {
      return repoJson(requireRepo(args.owner, args.repo));
    }
    case 'create_issue': {
      const repo = requireRepo(args.owner, args.repo);
      const ts = forge.clock.tick();
      const issue: IssueRec = {
        id: forge.nextIssueId(),
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        userLogin: VIEWER.login,
        createdAt: ts,
        updatedAt: ts,
        comments: [],
      };
      repo.issues.push(issue);
      return issueJson(repo, issue);
    }
    case 'list_issues': {
      const repo = requireRepo(args.owner, args.repo);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return list.map((i) => issueJson(repo, i));
    }
    case 'get_issue': {
      const repo = requireRepo(args.owner, args.repo);
      const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
      if (!issue) throw new ToolFailure('issue not found');
      return issueJson(repo, issue);
    }
    case 'create_pull_request': {
      const repo = requireRepo(args.owner, args.repo);
      const head = String(args.head).includes(':') ? (String(args.head).split(':').pop() as string) : String(args.head);
      const base = String(args.base);
      if (!repo.refs.has(`refs/heads/${head}`)) throw new ToolFailure(`head branch '${head}' does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) throw new ToolFailure(`base branch '${base}' does not exist`);
      const ts = forge.clock.tick();
      const pull: PullRec = {
        id: forge.nextIssueId(),
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        userLogin: VIEWER.login,
        createdAt: ts,
        updatedAt: ts,
      };
      repo.pulls.push(pull);
      return pullJson(repo, pull);
    }
    case 'list_pull_requests': {
      const repo = requireRepo(args.owner, args.repo);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      return list.map((p) => pullJson(repo, p));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(args.owner, args.repo);
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) throw new ToolFailure('pull request not found');
      if (pull.merged || pull.state !== 'open') throw new ToolFailure('Pull Request is not mergeable');
      const result = performMerge(forge, repo, pull, 'squash');
      if (!result.ok) throw new ToolFailure('Pull Request is not mergeable: merge conflict');
      return pullJson(repo, pull);
    }
  }
  throw new ToolFailure(`unimplemented tool ${name}`);
}

// JSON-RPC handling ------------------------------------------------------------------------------

export interface McpReply {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleOne(request: Json): { status: number; body: unknown } | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Json;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          serverInfo: SERVER_INFO,
          capabilities: { tools: { listChanged: false } },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, toolsListResult()) };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        return { status: 200, body: rpcError(id, -32602, `unknown tool: ${toolName}`) };
      }
      const args = (params.arguments ?? {}) as Json;
      try {
        const value = runTool(toolName, args);
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text }], isError: false }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'tool failed';
        return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text: message }], isError: true }) };
      }
    }
    default: {
      if (isNotification) return null;
      return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };
    }
  }
}

/** Handle one POST /mcp body. Notifications answer 202 with no body. */
export function handleMCP(rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === 'object') {
        const reply = handleOne(entry as Json);
        if (reply && reply.body !== undefined) replies.push(reply.body);
      }
    }
    return { status: 200, body: replies };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const reply = handleOne(parsed as Json);
  if (reply === null) return { status: 202, body: undefined };
  return reply;
}
