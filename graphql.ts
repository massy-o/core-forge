// core-forge's GraphQL v4 surface: a small, deterministic executor for the document shapes
// gh and github-mcp-server send — viewer, repository fields, issue/pull connections with
// cursor pagination, node(id:) global ids, __type introspection, and the create/close/merge
// mutations. Global ids are stable per object (`R_…`, `I_…`, `PR_…`, `IC_…`), so repeated
// reads agree byte for byte. Unknown fields produce a GraphQL errors array with HTTP 200,
// as GitHub does.

import { forge, mergeFileMaps, performMerge, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Lexer

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc;
          j += 2;
        } else {
          value += source[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) {
        if (source[j] === '.') isFloat = true;
        j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet?: SelectionNode[];
}
type SelectionNode = FieldNode | { kind: 'inline'; typeCondition?: string; selectionSet: SelectionNode[] } | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }
  private expect(value: string): void {
    const t = this.next();
    if (t.value !== value) throw new Error(`expected '${value}', got '${t.value}'`);
  }
  private skip(value: string): boolean {
    if (this.peek().value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.value === '{') {
        doc.operations.push({ type: 'query', variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefaults = new Map<string, ValueNode>();
        if (this.skip('(')) {
          while (this.peek().value !== ')') {
            this.expect('$');
            const varName = this.next().value;
            this.expect(':');
            this.parseType();
            if (this.skip('=')) variableDefaults.set(varName, this.parseValue());
            this.skipDirectives();
          }
          this.expect(')');
        }
        this.skipDirectives();
        doc.operations.push({ type, name, variableDefaults, selectionSet: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        const typeCondition = this.next().value;
        this.skipDirectives();
        doc.fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'subscription') {
        throw new Error('subscriptions are not supported');
      } else {
        this.next();
      }
    }
    return doc;
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    this.skip('!');
  }

  private skipDirectives(): void {
    while (this.skip('@')) {
      this.next();
      if (this.skip('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.value === '(') depth++;
          else if (t.value === ')') depth--;
          else if (t.kind === 'eof') break;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.next().value;
      let alias: string | undefined;
      if (this.skip(':')) {
        alias = name;
        name = this.next().value;
      }
      const args: FieldNode['args'] = [];
      if (this.skip('(')) {
        while (this.peek().value !== ')') {
          const argName = this.next().value;
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      this.skipDirectives();
      let selectionSet: SelectionNode[] | undefined;
      if (this.peek().value === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.value === '$') return { kind: 'variable', name: this.next().value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek().value !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek().value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token '${t.value}'`);
  }
}

// ---------------------------------------------------------------------------------------------
// Schema (for introspection and unknown-field validation)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'],
  Organization: ['id', 'login', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'isPrivate', 'isArchived', 'description', 'createdAt', 'updatedAt', 'pushedAt', 'url', 'sshUrl',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'author'],
  GitActor: ['name', 'email', 'date'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'closed', 'url', 'repository', 'assignees', 'milestone',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'comments', 'commits',
    'createdAt', 'updatedAt', 'closedAt', 'closed', 'url', 'repository', 'mergeCommit', 'additions', 'deletions', 'changedFiles',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Directive: ['name', 'description', 'locations', 'args'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'used'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

// ---------------------------------------------------------------------------------------------
// Execution

interface GNode {
  t: string;
  v: unknown;
}

function node(t: string, v: unknown): GNode {
  return { t, v };
}

interface ExecCtx {
  variables: Map<string, unknown>;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
  errors: { message: string }[];
  operationType: 'query' | 'mutation';
}

function evalValue(value: ValueNode, ctx: ExecCtx): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables.get(value.name);
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((v) => evalValue(v, ctx));
    case 'object': {
      const out: Json = {};
      for (const f of value.fields) out[f.name] = evalValue(f.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const arg of field.args) out.set(arg.name, evalValue(arg.value, ctx));
  return out;
}

// Global id helpers ---------------------------------------------------------------

function repoGid(repo: RepoRec): string {
  return `R_${repo.id}`;
}
function issueGid(issue: IssueRec): string {
  return `I_${issue.id}`;
}
function pullGid(pull: PullRec): string {
  return `PR_${pull.id}`;
}
function commentGid(id: number): string {
  return `IC_${id}`;
}

function findByGid(gid: string): GNode | null {
  if (gid.startsWith('R_')) {
    const id = parseInt(gid.slice(2), 10);
    for (const repo of forge.repos.values()) if (repo.id === id) return node('Repository', repo);
    return null;
  }
  if (gid.startsWith('PR_')) {
    const id = parseInt(gid.slice(3), 10);
    for (const repo of forge.repos.values()) {
      const pull = repo.pulls.find((p) => p.id === id);
      if (pull) return node('PullRequest', { repo, pull });
    }
    return null;
  }
  if (gid.startsWith('I_')) {
    const id = parseInt(gid.slice(2), 10);
    for (const repo of forge.repos.values()) {
      const issue = repo.issues.find((i) => i.id === id);
      if (issue) return node('Issue', { repo, issue });
    }
    return null;
  }
  if (gid.startsWith('U_')) {
    return node('User', VIEWER.login);
  }
  return null;
}

// Object wrappers -----------------------------------------------------------------

function repoNode(repo: RepoRec): GNode {
  return node('Repository', repo);
}
function issueNode(repo: RepoRec, issue: IssueRec): GNode {
  return node('Issue', { repo, issue });
}
function pullNode(repo: RepoRec, pull: PullRec): GNode {
  return node('PullRequest', { repo, pull });
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(repo: RepoRec, pull: PullRec): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  return mergeFileMaps(forge.store, baseTip, headTip) ? 'MERGEABLE' : 'CONFLICTING';
}

function pullFiles(repo: RepoRec, pull: PullRec): { path: string; additions: number; deletions: number; changeType: string }[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return [];
  const mb = forge.store.mergeBase(baseTip, headTip) ?? baseTip;
  const fromFiles = forge.store.filesAt(mb);
  const toFiles = forge.store.filesAt(headTip);
  const out: { path: string; additions: number; deletions: number; changeType: string }[] = [];
  for (const path of [...new Set([...fromFiles.keys(), ...toFiles.keys()])].sort()) {
    const from = fromFiles.get(path);
    const to = toFiles.get(path);
    if (from?.sha === to?.sha) continue;
    const oldLines = from ? (forge.store.read(from.sha)?.data.toString('utf8').split('\n').length ?? 0) : 0;
    const newLines = to ? (forge.store.read(to.sha)?.data.toString('utf8').split('\n').length ?? 0) : 0;
    out.push({
      path,
      additions: to ? newLines : 0,
      deletions: from ? oldLines : 0,
      changeType: !from ? 'ADDED' : !to ? 'DELETED' : 'MODIFIED',
    });
  }
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1] as string, 10) : 0;
  } catch {
    return 0;
  }
}

interface Connection {
  items: GNode[];
  total: number;
  startIndex: number;
}

function paginate(items: GNode[], args: Map<string, unknown>): Connection {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : items.length;
  const after = args.get('after');
  const start = after === undefined || after === null ? 0 : indexFromCursor(after);
  return { items: items.slice(start, start + first), total: items.length, startIndex: start };
}

// Field resolution ------------------------------------------------------------------

function resolveField(source: GNode | null, field: FieldNode, ctx: ExecCtx): unknown {
  const args = argsOf(field, ctx);
  const typeName = source === null ? (ctx.operationType === 'mutation' ? 'Mutation' : 'Query') : source.t;

  if (field.name === '__type' && (typeName === 'Query' || typeName === 'Mutation')) {
    const name = args.get('name');
    if (typeof name !== 'string') return null;
    if (TYPE_FIELDS[name]) return node('__Type', { name, kind: 'OBJECT' });
    if (ENUM_VALUES[name]) return node('__Type', { name, kind: 'ENUM' });
    return null;
  }
  if (field.name === '__schema' && typeName === 'Query') return node('__Schema', {});

  const known = TYPE_FIELDS[typeName];
  if (known && !known.includes(field.name)) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }

  switch (typeName) {
    case 'Query': {
      switch (field.name) {
        case 'viewer':
          return node('User', VIEWER.login);
        case 'repository': {
          const owner = args.get('owner');
          const name = args.get('name');
          if (typeof owner !== 'string' || typeof name !== 'string' || owner !== VIEWER.login) return null;
          const repo = forge.getRepo(owner, name);
          return repo ? repoNode(repo) : null;
        }
        case 'node': {
          const id = args.get('id');
          return typeof id === 'string' ? findByGid(id) : null;
        }
        case 'rateLimit':
          return node('RateLimit', {});
      }
      break;
    }
    case 'Mutation': {
      return resolveMutation(field.name, args, ctx);
    }
    case 'User': {
      const login = source?.v as string;
      switch (field.name) {
        case 'login':
          return login;
        case 'id':
          return `U_${VIEWER.id}`;
        case 'name':
          return VIEWER.name;
        case 'email':
          return VIEWER.email;
        case 'url':
          return `/${login}`;
        case 'avatarUrl':
          return '';
      }
      break;
    }
    case 'Repository': {
      const repo = source?.v as RepoRec;
      switch (field.name) {
        case 'id':
          return repoGid(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return node('User', repo.owner);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip ? node('Ref', { name: repo.defaultBranch, target: tip }) : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'hasPullRequestsEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'isArchived':
          return false;
        case 'description':
          return repo.description;
        case 'createdAt':
          return forge.clock.iso(repo.createdAt);
        case 'updatedAt':
          return forge.clock.iso(repo.updatedAt);
        case 'pushedAt':
          return forge.clock.iso(repo.updatedAt);
        case 'url':
          return `/repos/${repo.owner}/${repo.name}`;
        case 'issue': {
          const number = args.get('number');
          const issue = repo.issues.find((i) => i.number === number);
          return issue ? issueNode(repo, issue) : null;
        }
        case 'issues': {
          const states = args.get('states');
          const orderBy = args.get('orderBy') as Json | undefined;
          let list = [...repo.issues];
          if (Array.isArray(states)) {
            const wanted = states.map((s) => String(s).toLowerCase());
            list = list.filter((i) => wanted.includes(i.state));
          }
          const direction = orderBy && typeof orderBy === 'object' ? String((orderBy as Json).direction ?? 'DESC') : 'DESC';
          list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
          const page = paginate(list.map((i) => issueNode(repo, i)), args);
          return node('IssueConnection', page);
        }
        case 'pullRequest': {
          const number = args.get('number');
          const pull = repo.pulls.find((p) => p.number === number);
          return pull ? pullNode(repo, pull) : null;
        }
        case 'pullRequests': {
          const states = args.get('states');
          let list = [...repo.pulls];
          if (Array.isArray(states)) {
            const wanted = states.map((s) => String(s));
            list = list.filter((p) => wanted.includes(pullState(p)));
          }
          list.sort((a, b) => b.number - a.number);
          const page = paginate(list.map((p) => pullNode(repo, p)), args);
          return node('PullRequestConnection', page);
        }
      }
      break;
    }
    case 'Ref': {
      const ref = source?.v as { name: string; target: string };
      if (field.name === 'name') return ref.name;
      if (field.name === 'id') return `REF_${ref.name}`;
      if (field.name === 'prefix') return 'refs/heads/';
      if (field.name === 'target') return node('Commit', ref.target);
      break;
    }
    case 'Commit': {
      const sha = source?.v as string;
      const info = forge.store.commitInfo(sha);
      if (field.name === 'id' || field.name === 'oid') return sha;
      if (field.name === 'message') return info?.message ?? '';
      if (field.name === 'messageHeadline') return (info?.message ?? '').split('\n')[0];
      if (field.name === 'committedDate') return info ? forge.clock.iso(info.committerTs) : null;
      break;
    }
    case 'Issue': {
      const { repo, issue } = source?.v as { repo: RepoRec; issue: IssueRec };
      switch (field.name) {
        case 'id':
          return issueGid(issue);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
        case 'bodyText':
          return issue.body;
        case 'author':
          return node('User', issue.userLogin);
        case 'labels': {
          const labels = issue.labels
            .map((name) => repo.labels.get(name))
            .filter((l) => l !== undefined)
            .map((l) => node('Label', l));
          return node('LabelConnection', paginate(labels, args));
        }
        case 'comments': {
          const comments = issue.comments.map((c) => node('IssueComment', { repo, issue, comment: c }));
          return node('IssueCommentConnection', paginate(comments, args));
        }
        case 'createdAt':
          return forge.clock.iso(issue.createdAt);
        case 'updatedAt':
          return forge.clock.iso(issue.updatedAt);
        case 'closedAt':
          return issue.state === 'closed' ? forge.clock.iso(issue.updatedAt) : null;
        case 'closed':
          return issue.state === 'closed';
        case 'url':
          return `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'repository':
          return repoNode(repo);
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = source?.v as { repo: RepoRec; pull: PullRec };
      switch (field.name) {
        case 'id':
          return pullGid(pull);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt !== null ? forge.clock.iso(pull.mergedAt) : null;
        case 'mergeable':
          return pullMergeable(repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef': {
          const tip = repo.refs.get(`refs/heads/${pull.headRef}`);
          return tip ? node('Ref', { name: pull.headRef, target: tip }) : null;
        }
        case 'baseRef': {
          const tip = repo.refs.get(`refs/heads/${pull.baseRef}`);
          return tip ? node('Ref', { name: pull.baseRef, target: tip }) : null;
        }
        case 'files': {
          const files = pullFiles(repo, pull).map((f) => node('PullRequestChangedFile', f));
          return node('PullRequestChangedFileConnection', paginate(files, args));
        }
        case 'author':
          return node('User', pull.userLogin);
        case 'createdAt':
          return forge.clock.iso(pull.createdAt);
        case 'updatedAt':
          return forge.clock.iso(pull.updatedAt);
        case 'closedAt':
          return pull.state === 'closed' ? forge.clock.iso(pull.updatedAt) : null;
        case 'closed':
          return pull.state === 'closed';
        case 'url':
          return `/repos/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'repository':
          return repoNode(repo);
        case 'mergeCommit':
          return pull.mergeCommitSha ? node('Commit', pull.mergeCommitSha) : null;
        case 'additions':
          return pullFiles(repo, pull).reduce((sum, f) => sum + f.additions, 0);
        case 'deletions':
          return pullFiles(repo, pull).reduce((sum, f) => sum + f.deletions, 0);
        case 'changedFiles':
          return pullFiles(repo, pull).length;
      }
      break;
    }
    case 'PullRequestChangedFile': {
      const file = source?.v as { path: string; additions: number; deletions: number; changeType: string };
      if (field.name === 'path') return file.path;
      if (field.name === 'additions') return file.additions;
      if (field.name === 'deletions') return file.deletions;
      if (field.name === 'changeType') return file.changeType;
      break;
    }
    case 'Label': {
      const label = source?.v as { id: number; name: string; color: string; description: string | null };
      if (field.name === 'id') return `L_${label.id}`;
      if (field.name === 'name') return label.name;
      if (field.name === 'color') return label.color;
      if (field.name === 'description') return label.description;
      break;
    }
    case 'IssueComment': {
      const { comment } = source?.v as { comment: { id: number; body: string; userLogin: string; createdAt: number; updatedAt: number } };
      switch (field.name) {
        case 'id':
          return commentGid(comment.id);
        case 'databaseId':
          return comment.id;
        case 'body':
          return comment.body;
        case 'author':
          return node('User', comment.userLogin);
        case 'createdAt':
          return forge.clock.iso(comment.createdAt);
        case 'updatedAt':
          return forge.clock.iso(comment.updatedAt);
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection': {
      const conn = source?.v as Connection;
      if (field.name === 'nodes') return conn.items;
      if (field.name === 'totalCount') return conn.total;
      if (field.name === 'edges') {
        return conn.items.map((item, i) => node('Edge', { item, cursor: cursorFor(conn.startIndex + i + 1) }));
      }
      if (field.name === 'pageInfo') {
        const hasNext = conn.startIndex + conn.items.length < conn.total;
        return node('PageInfo', {
          hasNextPage: hasNext,
          hasPreviousPage: conn.startIndex > 0,
          startCursor: conn.items.length > 0 ? cursorFor(conn.startIndex + 1) : null,
          endCursor: conn.items.length > 0 ? cursorFor(conn.startIndex + conn.items.length) : null,
        });
      }
      break;
    }
    case 'Edge': {
      const edge = source?.v as { item: GNode; cursor: string };
      if (field.name === 'node') return edge.item;
      if (field.name === 'cursor') return edge.cursor;
      break;
    }
    case 'PageInfo': {
      const info = source?.v as Record<string, unknown>;
      return info[field.name] ?? null;
    }
    case '__Type': {
      const type = source?.v as { name: string; kind: string };
      if (field.name === 'name') return type.name;
      if (field.name === 'kind') return type.kind;
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        return (TYPE_FIELDS[type.name] ?? []).map((name) => node('__Field', { name }));
      }
      if (field.name === 'enumValues') {
        return (ENUM_VALUES[type.name] ?? []).map((name) => node('__EnumValue', { name }));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      const entry = source?.v as { name: string };
      if (field.name === 'name') return entry.name;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      return null;
    }
    case '__Schema': {
      if (field.name === 'queryType') return node('__Type', { name: 'Query', kind: 'OBJECT' });
      if (field.name === 'mutationType') return node('__Type', { name: 'Mutation', kind: 'OBJECT' });
      if (field.name === 'types') {
        return Object.keys(TYPE_FIELDS).map((name) => node('__Type', { name, kind: 'OBJECT' }));
      }
      return null;
    }
    case 'RateLimit': {
      if (field.name === 'limit') return 5000;
      if (field.name === 'cost') return 1;
      if (field.name === 'remaining') return 4999;
      if (field.name === 'used') return 1;
      if (field.name === 'resetAt') return '2030-01-01T00:00:00Z';
      return null;
    }
    case 'CreateIssuePayload': {
      const payload = source?.v as { repo: RepoRec; issue: IssueRec };
      if (field.name === 'issue') return issueNode(payload.repo, payload.issue);
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'CloseIssuePayload': {
      const payload = source?.v as { repo: RepoRec; issue: IssueRec };
      if (field.name === 'issue') return issueNode(payload.repo, payload.issue);
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload': {
      const payload = source?.v as { repo: RepoRec; pull: PullRec };
      if (field.name === 'pullRequest') return pullNode(payload.repo, payload.pull);
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'MergePullRequestPayload': {
      const payload = source?.v as { repo: RepoRec; pull: PullRec };
      if (field.name === 'pullRequest') return pullNode(payload.repo, payload.pull);
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      const payload = source?.v as { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string; userLogin: string; createdAt: number; updatedAt: number } };
      if (field.name === 'commentEdge') {
        return node('IssueCommentEdge', { node: node('IssueComment', { repo: payload.repo, issue: payload.issue, comment: payload.comment }), cursor: cursorFor(1) });
      }
      if (field.name === 'subject') return issueNode(payload.repo, payload.issue);
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'IssueCommentEdge': {
      const edge = source?.v as { node: GNode; cursor: string };
      if (field.name === 'node') return edge.node;
      if (field.name === 'cursor') return edge.cursor;
      break;
    }
  }
  return null;
}

function resolveMutation(name: string, args: Map<string, unknown>, ctx: ExecCtx): unknown {
  const input = (args.get('input') ?? {}) as Json;
  switch (name) {
    case 'createIssue': {
      const target = typeof input.repositoryId === 'string' ? findByGid(input.repositoryId) : null;
      if (!target || target.t !== 'Repository') {
        ctx.errors.push({ message: 'repositoryId does not name a repository' });
        return null;
      }
      const repo = target.v as RepoRec;
      const ts = forge.clock.tick();
      const issue: IssueRec = {
        id: forge.nextIssueId(),
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        userLogin: VIEWER.login,
        createdAt: ts,
        updatedAt: ts,
        comments: [],
      };
      repo.issues.push(issue);
      return node('CreateIssuePayload', { repo, issue });
    }
    case 'closeIssue': {
      const target = typeof input.issueId === 'string' ? findByGid(input.issueId) : null;
      if (!target || target.t !== 'Issue') {
        ctx.errors.push({ message: 'issueId does not name an issue' });
        return null;
      }
      const { repo, issue } = target.v as { repo: RepoRec; issue: IssueRec };
      issue.state = 'closed';
      issue.updatedAt = forge.clock.tick();
      return node('CloseIssuePayload', { repo, issue });
    }
    case 'createPullRequest': {
      const target = typeof input.repositoryId === 'string' ? findByGid(input.repositoryId) : null;
      if (!target || target.t !== 'Repository') {
        ctx.errors.push({ message: 'repositoryId does not name a repository' });
        return null;
      }
      const repo = target.v as RepoRec;
      const headRefName = String(input.headRefName ?? '');
      const baseRefName = String(input.baseRefName ?? '');
      if (!repo.refs.has(`refs/heads/${headRefName}`) || !repo.refs.has(`refs/heads/${baseRefName}`)) {
        ctx.errors.push({ message: 'head or base branch does not exist' });
        return null;
      }
      const ts = forge.clock.tick();
      const pull: PullRec = {
        id: forge.nextIssueId(),
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: headRefName,
        baseRef: baseRefName,
        userLogin: VIEWER.login,
        createdAt: ts,
        updatedAt: ts,
      };
      repo.pulls.push(pull);
      return node('CreatePullRequestPayload', { repo, pull });
    }
    case 'mergePullRequest': {
      const target = typeof input.pullRequestId === 'string' ? findByGid(input.pullRequestId) : null;
      if (!target || target.t !== 'PullRequest') {
        ctx.errors.push({ message: 'pullRequestId does not name a pull request' });
        return null;
      }
      const { repo, pull } = target.v as { repo: RepoRec; pull: PullRec };
      if (pull.merged || pull.state !== 'open') {
        ctx.errors.push({ message: 'Pull Request is not mergeable' });
        return node('MergePullRequestPayload', { repo, pull });
      }
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      const result = performMerge(forge, repo, pull, method);
      if (!result.ok) {
        ctx.errors.push({ message: 'Pull Request is not mergeable: merge conflict' });
        return null;
      }
      return node('MergePullRequestPayload', { repo, pull });
    }
    case 'addComment': {
      const target = typeof input.subjectId === 'string' ? findByGid(input.subjectId) : null;
      if (!target || target.t !== 'Issue') {
        ctx.errors.push({ message: 'subjectId does not name an issue' });
        return null;
      }
      const { repo, issue } = target.v as { repo: RepoRec; issue: IssueRec };
      const ts = forge.clock.tick();
      const comment = { id: forge.nextCommentId(), body: String(input.body ?? ''), userLogin: VIEWER.login, createdAt: ts, updatedAt: ts };
      issue.comments.push(comment);
      issue.updatedAt = ts;
      return node('AddCommentPayload', { repo, issue, comment });
    }
  }
  ctx.errors.push({ message: `Unknown mutation '${name}'` });
  return null;
}

// Selection-set execution -----------------------------------------------------------

function executeSelectionSet(source: GNode | null, selections: SelectionNode[], ctx: ExecCtx): Json {
  const out: Json = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      const value = resolveField(source, selection, ctx);
      out[key] = completeValue(value, selection, ctx);
    } else if (selection.kind === 'inline') {
      if (!selection.typeCondition || (source !== null && source.t === selection.typeCondition) || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(source, selection.selectionSet, ctx));
      }
    } else if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && (!fragment.typeCondition || (source !== null && source.t === fragment.typeCondition))) {
        Object.assign(out, executeSelectionSet(source, fragment.selectionSet, ctx));
      }
    }
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object' && 't' in (value as object) && 'v' in (value as object)) {
    const gnode = value as GNode;
    if (!field.selectionSet) return null;
    return executeSelectionSet(gnode, field.selectionSet, ctx);
  }
  return value;
}

// Entry point ------------------------------------------------------------------------

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function executeOne(request: { query?: unknown; variables?: unknown; operationName?: unknown }): Json {
  if (typeof request.query !== 'string') {
    return { errors: [{ message: 'query must be a string' }] };
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(lex(request.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operations = doc.operations;
  let operation = operations[0];
  if (typeof request.operationName === 'string') {
    operation = operations.find((op) => op.name === request.operationName) ?? operation;
  }
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  const variables = new Map<string, unknown>();
  if (request.variables && typeof request.variables === 'object' && !Array.isArray(request.variables)) {
    for (const [key, value] of Object.entries(request.variables as Json)) variables.set(key, value);
  }
  for (const [name, defaultValue] of operation.variableDefaults) {
    if (!variables.has(name)) {
      const ctx0: ExecCtx = { variables, fragments: doc.fragments, errors: [], operationType: operation.type };
      variables.set(name, evalValue(defaultValue, ctx0));
    }
  }
  const ctx: ExecCtx = { variables, fragments: doc.fragments, errors: [], operationType: operation.type };
  const data = executeSelectionSet(null, operation.selectionSet, ctx);
  const response: Json = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(rawBody: Buffer): GraphQLReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeOne((entry ?? {}) as Json)) };
  }
  return { status: 200, body: executeOne((parsed ?? {}) as Json) };
}
