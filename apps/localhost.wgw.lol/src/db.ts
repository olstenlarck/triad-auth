import { now, randomId } from "./utils";

export interface User {
  id: string;
  handle: string;
  display_name: string;
  kind: "human" | "agent";
  avatar_url: string | null;
  created_at: number;
}

export interface Identity {
  id: string;
  user_id: string;
  issuer: string;
  subject: string;
  email: string | null;
  email_verified: number;
  owner_email: string | null;
  created_at: number;
}

export interface Repo {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  default_branch: string;
  imported_from: string | null;
  import_status: string | null;
  created_at: number;
  updated_at: number;
  pushed_at: number | null;
}

export interface RepoWithOwner extends Repo {
  owner_handle: string;
}

export interface Token {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string;
  repo_id: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

export interface PathRule {
  id: string;
  repo_id: string;
  pattern: string;
  visibility: "public" | "private";
  created_at: number;
}

export interface Environment {
  id: string;
  repo_id: string;
  name: string;
  created_at: number;
}

export interface EnvVar {
  id: string;
  environment_id: string;
  key: string;
  value_enc: string;
  is_secret: number;
  created_at: number;
  updated_at: number;
}

export interface PullRequest {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string;
  author_id: string;
  base_ref: string;
  head_ref: string;
  state: "open" | "merged" | "closed";
  merge_sha: string | null;
  ai_summary: string | null;
  created_at: number;
  updated_at: number;
  merged_at: number | null;
}

export interface PullRequestWithAuthor extends PullRequest {
  author_handle: string;
}

export interface Comment {
  id: string;
  pr_id: string;
  author_id: string;
  body: string;
  created_at: number;
  author_handle: string;
}

export interface Event {
  id: string;
  repo_id: string;
  actor_id: string | null;
  type: string;
  payload: string;
  summary: string | null;
  created_at: number;
}

export type Role = "read" | "write" | "admin";

export class Db {
  constructor(private readonly d1: D1Database) {}

  // ---- users and identities ----

  async userById(id: string): Promise<User | null> {
    return this.d1.prepare("select * from users where id = ?").bind(id).first<User>();
  }

  async userByHandle(handle: string): Promise<User | null> {
    return this.d1
      .prepare("select * from users where handle = ? collate nocase")
      .bind(handle)
      .first<User>();
  }

  async identity(issuer: string, subject: string): Promise<(Identity & { user: User }) | null> {
    const identity = await this.d1
      .prepare("select * from identities where issuer = ? and subject = ?")
      .bind(issuer, subject)
      .first<Identity>();
    if (!identity) {
      return null;
    }
    const user = await this.userById(identity.user_id);

    return user ? { ...identity, user } : null;
  }

  async identitiesOf(userId: string): Promise<Identity[]> {
    const { results } = await this.d1
      .prepare("select * from identities where user_id = ?")
      .bind(userId)
      .all<Identity>();

    return results;
  }

  async createUser(input: {
    handle: string;
    displayName: string;
    kind: User["kind"];
    avatarUrl?: string | null;
    identity: {
      issuer: string;
      subject: string;
      email?: string | null;
      emailVerified?: boolean;
      ownerEmail?: string | null;
    };
  }): Promise<User> {
    const id = `usr_${randomId(16)}`;
    const createdAt = now();
    await this.d1.batch([
      this.d1
        .prepare(
          "insert into users (id, handle, display_name, kind, avatar_url, created_at) values (?, ?, ?, ?, ?, ?)",
        )
        .bind(id, input.handle, input.displayName, input.kind, input.avatarUrl ?? null, createdAt),
      this.d1
        .prepare(
          "insert into identities (id, user_id, issuer, subject, email, email_verified, owner_email, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          `idn_${randomId(16)}`,
          id,
          input.identity.issuer,
          input.identity.subject,
          input.identity.email ?? null,
          input.identity.emailVerified ? 1 : 0,
          input.identity.ownerEmail ?? null,
          createdAt,
        ),
    ]);

    return {
      id,
      handle: input.handle,
      display_name: input.displayName,
      kind: input.kind,
      avatar_url: input.avatarUrl ?? null,
      created_at: createdAt,
    };
  }

  async handleIsFree(handle: string): Promise<boolean> {
    return (await this.userByHandle(handle)) === null;
  }

  // ---- sessions ----

  async createSession(
    userId: string,
    userAgent: string | null,
    ttlSeconds: number,
  ): Promise<string> {
    const id = randomId(40);
    const createdAt = now();
    await this.d1
      .prepare(
        "insert into sessions (id, user_id, created_at, expires_at, user_agent) values (?, ?, ?, ?, ?)",
      )
      .bind(id, userId, createdAt, createdAt + ttlSeconds, userAgent)
      .run();

    return id;
  }

  async sessionUser(sessionId: string): Promise<User | null> {
    return this.d1
      .prepare(
        "select u.* from sessions s join users u on u.id = s.user_id where s.id = ? and s.expires_at > ?",
      )
      .bind(sessionId, now())
      .first<User>();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.d1.prepare("delete from sessions where id = ?").bind(sessionId).run();
  }

  // ---- tokens ----

  async createToken(input: {
    userId: string;
    name: string;
    prefix: string;
    hash: string;
    scopes: string[];
    repoId?: string | null;
    expiresAt?: number | null;
  }): Promise<Token> {
    const token: Token = {
      id: `tok_${randomId(16)}`,
      user_id: input.userId,
      name: input.name,
      prefix: input.prefix,
      hash: input.hash,
      scopes: input.scopes.join(" "),
      repo_id: input.repoId ?? null,
      expires_at: input.expiresAt ?? null,
      last_used_at: null,
      created_at: now(),
    };
    await this.d1
      .prepare(
        "insert into tokens (id, user_id, name, prefix, hash, scopes, repo_id, expires_at, last_used_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, null, ?)",
      )
      .bind(
        token.id,
        token.user_id,
        token.name,
        token.prefix,
        token.hash,
        token.scopes,
        token.repo_id,
        token.expires_at,
        token.created_at,
      )
      .run();

    return token;
  }

  async tokenByHash(hash: string): Promise<(Token & { user: User }) | null> {
    const token = await this.d1
      .prepare("select * from tokens where hash = ?")
      .bind(hash)
      .first<Token>();
    if (!token || (token.expires_at !== null && token.expires_at < now())) {
      return null;
    }
    const user = await this.userById(token.user_id);
    if (!user) {
      return null;
    }

    return { ...token, user };
  }

  async touchToken(id: string): Promise<void> {
    await this.d1.prepare("update tokens set last_used_at = ? where id = ?").bind(now(), id).run();
  }

  async tokensOf(userId: string): Promise<Token[]> {
    const { results } = await this.d1
      .prepare("select * from tokens where user_id = ? order by created_at desc")
      .bind(userId)
      .all<Token>();

    return results;
  }

  async deleteToken(userId: string, id: string): Promise<boolean> {
    const result = await this.d1
      .prepare("delete from tokens where id = ? and user_id = ?")
      .bind(id, userId)
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  // ---- repos ----

  async repo(ownerHandle: string, name: string): Promise<RepoWithOwner | null> {
    return this.d1
      .prepare(
        "select r.*, u.handle as owner_handle from repos r join users u on u.id = r.owner_id where u.handle = ? collate nocase and r.name = ? collate nocase",
      )
      .bind(ownerHandle, name)
      .first<RepoWithOwner>();
  }

  async repoById(id: string): Promise<RepoWithOwner | null> {
    return this.d1
      .prepare(
        "select r.*, u.handle as owner_handle from repos r join users u on u.id = r.owner_id where r.id = ?",
      )
      .bind(id)
      .first<RepoWithOwner>();
  }

  async createRepo(input: {
    ownerId: string;
    name: string;
    description: string;
    visibility: Repo["visibility"];
    defaultBranch: string;
    importedFrom?: string | null;
  }): Promise<Repo> {
    const repo: Repo = {
      id: `repo_${randomId(16)}`,
      owner_id: input.ownerId,
      name: input.name,
      description: input.description,
      visibility: input.visibility,
      default_branch: input.defaultBranch,
      imported_from: input.importedFrom ?? null,
      import_status: input.importedFrom ? "running" : null,
      created_at: now(),
      updated_at: now(),
      pushed_at: null,
    };
    await this.d1
      .prepare(
        "insert into repos (id, owner_id, name, description, visibility, default_branch, imported_from, import_status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        repo.id,
        repo.owner_id,
        repo.name,
        repo.description,
        repo.visibility,
        repo.default_branch,
        repo.imported_from,
        repo.import_status,
        repo.created_at,
        repo.updated_at,
      )
      .run();

    return repo;
  }

  async updateRepo(
    id: string,
    patch: Partial<
      Pick<Repo, "description" | "visibility" | "default_branch" | "import_status" | "pushed_at">
    >,
  ): Promise<void> {
    const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (fields.length === 0) {
      return;
    }
    const assignments = fields.map(([key]) => `${key} = ?`).join(", ");
    await this.d1
      .prepare(`update repos set ${assignments}, updated_at = ? where id = ?`)
      .bind(...fields.map(([, value]) => value), now(), id)
      .run();
  }

  async deleteRepo(id: string): Promise<void> {
    await this.d1.prepare("delete from repos where id = ?").bind(id).run();
  }

  async reposOwnedBy(userId: string): Promise<RepoWithOwner[]> {
    const { results } = await this.d1
      .prepare(
        "select r.*, u.handle as owner_handle from repos r join users u on u.id = r.owner_id where r.owner_id = ? order by coalesce(r.pushed_at, r.updated_at) desc",
      )
      .bind(userId)
      .all<RepoWithOwner>();

    return results;
  }

  async reposVisibleTo(userId: string | null, limit = 50): Promise<RepoWithOwner[]> {
    const statement = userId
      ? this.d1
          .prepare(
            `select distinct r.*, u.handle as owner_handle from repos r
             join users u on u.id = r.owner_id
             left join collaborators c on c.repo_id = r.id and c.user_id = ?
             where r.visibility = 'public' or r.owner_id = ? or c.user_id is not null
             order by coalesce(r.pushed_at, r.updated_at) desc limit ?`,
          )
          .bind(userId, userId, limit)
      : this.d1
          .prepare(
            "select r.*, u.handle as owner_handle from repos r join users u on u.id = r.owner_id where r.visibility = 'public' order by coalesce(r.pushed_at, r.updated_at) desc limit ?",
          )
          .bind(limit);
    const { results } = await statement.all<RepoWithOwner>();

    return results;
  }

  async roleOf(repo: Repo, userId: string | null): Promise<Role | null> {
    if (!userId) {
      return null;
    }
    if (repo.owner_id === userId) {
      return "admin";
    }
    const row = await this.d1
      .prepare("select role from collaborators where repo_id = ? and user_id = ?")
      .bind(repo.id, userId)
      .first<{ role: Role }>();

    return row?.role ?? null;
  }

  async setCollaborator(repoId: string, userId: string, role: Role): Promise<void> {
    await this.d1
      .prepare(
        "insert into collaborators (repo_id, user_id, role, created_at) values (?, ?, ?, ?) on conflict(repo_id, user_id) do update set role = excluded.role",
      )
      .bind(repoId, userId, role, now())
      .run();
  }

  async collaborators(
    repoId: string,
  ): Promise<Array<{ handle: string; role: Role; user_id: string }>> {
    const { results } = await this.d1
      .prepare(
        "select u.handle, c.role, c.user_id from collaborators c join users u on u.id = c.user_id where c.repo_id = ?",
      )
      .bind(repoId)
      .all<{ handle: string; role: Role; user_id: string }>();

    return results;
  }

  async removeCollaborator(repoId: string, userId: string): Promise<void> {
    await this.d1
      .prepare("delete from collaborators where repo_id = ? and user_id = ?")
      .bind(repoId, userId)
      .run();
  }

  // ---- path rules ----

  async pathRules(repoId: string): Promise<PathRule[]> {
    const { results } = await this.d1
      .prepare("select * from path_rules where repo_id = ? order by pattern")
      .bind(repoId)
      .all<PathRule>();

    return results;
  }

  async setPathRule(
    repoId: string,
    pattern: string,
    visibility: PathRule["visibility"],
  ): Promise<void> {
    await this.d1
      .prepare(
        "insert into path_rules (id, repo_id, pattern, visibility, created_at) values (?, ?, ?, ?, ?) on conflict(repo_id, pattern) do update set visibility = excluded.visibility",
      )
      .bind(`rule_${randomId(12)}`, repoId, pattern, visibility, now())
      .run();
  }

  async deletePathRule(repoId: string, pattern: string): Promise<void> {
    await this.d1
      .prepare("delete from path_rules where repo_id = ? and pattern = ?")
      .bind(repoId, pattern)
      .run();
  }

  // ---- environments ----

  async environments(repoId: string): Promise<Environment[]> {
    const { results } = await this.d1
      .prepare("select * from environments where repo_id = ? order by name")
      .bind(repoId)
      .all<Environment>();

    return results;
  }

  async environment(repoId: string, name: string): Promise<Environment | null> {
    return this.d1
      .prepare("select * from environments where repo_id = ? and name = ?")
      .bind(repoId, name)
      .first<Environment>();
  }

  async createEnvironment(repoId: string, name: string): Promise<Environment> {
    const environment: Environment = {
      id: `env_${randomId(12)}`,
      repo_id: repoId,
      name,
      created_at: now(),
    };
    await this.d1
      .prepare(
        "insert into environments (id, repo_id, name, created_at) values (?, ?, ?, ?) on conflict(repo_id, name) do nothing",
      )
      .bind(environment.id, repoId, name, environment.created_at)
      .run();

    return (await this.environment(repoId, name)) ?? environment;
  }

  async deleteEnvironment(repoId: string, name: string): Promise<void> {
    await this.d1
      .prepare("delete from environments where repo_id = ? and name = ?")
      .bind(repoId, name)
      .run();
  }

  async envVars(environmentId: string): Promise<EnvVar[]> {
    const { results } = await this.d1
      .prepare("select * from env_vars where environment_id = ? order by key")
      .bind(environmentId)
      .all<EnvVar>();

    return results;
  }

  async setEnvVar(
    environmentId: string,
    key: string,
    valueEnc: string,
    isSecret: boolean,
  ): Promise<void> {
    await this.d1
      .prepare(
        "insert into env_vars (id, environment_id, key, value_enc, is_secret, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?) on conflict(environment_id, key) do update set value_enc = excluded.value_enc, is_secret = excluded.is_secret, updated_at = excluded.updated_at",
      )
      .bind(`var_${randomId(12)}`, environmentId, key, valueEnc, isSecret ? 1 : 0, now(), now())
      .run();
  }

  async deleteEnvVar(environmentId: string, key: string): Promise<void> {
    await this.d1
      .prepare("delete from env_vars where environment_id = ? and key = ?")
      .bind(environmentId, key)
      .run();
  }

  // ---- pull requests ----

  async pullRequests(
    repoId: string,
    state?: PullRequest["state"],
  ): Promise<PullRequestWithAuthor[]> {
    const statement = state
      ? this.d1
          .prepare(
            "select p.*, u.handle as author_handle from pull_requests p join users u on u.id = p.author_id where p.repo_id = ? and p.state = ? order by p.number desc",
          )
          .bind(repoId, state)
      : this.d1
          .prepare(
            "select p.*, u.handle as author_handle from pull_requests p join users u on u.id = p.author_id where p.repo_id = ? order by p.number desc",
          )
          .bind(repoId);
    const { results } = await statement.all<PullRequestWithAuthor>();

    return results;
  }

  async pullRequest(repoId: string, number: number): Promise<PullRequestWithAuthor | null> {
    return this.d1
      .prepare(
        "select p.*, u.handle as author_handle from pull_requests p join users u on u.id = p.author_id where p.repo_id = ? and p.number = ?",
      )
      .bind(repoId, number)
      .first<PullRequestWithAuthor>();
  }

  async createPullRequest(input: {
    repoId: string;
    title: string;
    body: string;
    authorId: string;
    baseRef: string;
    headRef: string;
  }): Promise<PullRequest> {
    const next = await this.d1
      .prepare("select coalesce(max(number), 0) + 1 as n from pull_requests where repo_id = ?")
      .bind(input.repoId)
      .first<{ n: number }>();
    const pr: PullRequest = {
      id: `pr_${randomId(14)}`,
      repo_id: input.repoId,
      number: next?.n ?? 1,
      title: input.title,
      body: input.body,
      author_id: input.authorId,
      base_ref: input.baseRef,
      head_ref: input.headRef,
      state: "open",
      merge_sha: null,
      ai_summary: null,
      created_at: now(),
      updated_at: now(),
      merged_at: null,
    };
    await this.d1
      .prepare(
        "insert into pull_requests (id, repo_id, number, title, body, author_id, base_ref, head_ref, state, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
      )
      .bind(
        pr.id,
        pr.repo_id,
        pr.number,
        pr.title,
        pr.body,
        pr.author_id,
        pr.base_ref,
        pr.head_ref,
        pr.created_at,
        pr.updated_at,
      )
      .run();

    return pr;
  }

  async updatePullRequest(
    id: string,
    patch: Partial<
      Pick<PullRequest, "title" | "body" | "state" | "merge_sha" | "ai_summary" | "merged_at">
    >,
  ): Promise<void> {
    const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (fields.length === 0) {
      return;
    }
    const assignments = fields.map(([key]) => `${key} = ?`).join(", ");
    await this.d1
      .prepare(`update pull_requests set ${assignments}, updated_at = ? where id = ?`)
      .bind(...fields.map(([, value]) => value), now(), id)
      .run();
  }

  async comments(prId: string): Promise<Comment[]> {
    const { results } = await this.d1
      .prepare(
        "select c.*, u.handle as author_handle from pr_comments c join users u on u.id = c.author_id where c.pr_id = ? order by c.created_at",
      )
      .bind(prId)
      .all<Comment>();

    return results;
  }

  async addComment(prId: string, authorId: string, body: string): Promise<void> {
    await this.d1
      .prepare(
        "insert into pr_comments (id, pr_id, author_id, body, created_at) values (?, ?, ?, ?, ?)",
      )
      .bind(`cmt_${randomId(12)}`, prId, authorId, body, now())
      .run();
  }

  // ---- events ----

  async addEvent(input: {
    repoId: string;
    actorId: string | null;
    type: string;
    payload: unknown;
    summary?: string | null;
  }): Promise<void> {
    await this.d1
      .prepare(
        "insert into events (id, repo_id, actor_id, type, payload, summary, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        `evt_${randomId(14)}`,
        input.repoId,
        input.actorId,
        input.type,
        JSON.stringify(input.payload),
        input.summary ?? null,
        now(),
      )
      .run();
  }

  async events(
    repoId: string,
    limit = 30,
  ): Promise<Array<Event & { actor_handle: string | null }>> {
    const { results } = await this.d1
      .prepare(
        "select e.*, u.handle as actor_handle from events e left join users u on u.id = e.actor_id where e.repo_id = ? order by e.created_at desc limit ?",
      )
      .bind(repoId, limit)
      .all<Event & { actor_handle: string | null }>();

    return results;
  }

  // ---- device codes (CLI login) ----

  async createDeviceCode(input: {
    deviceCodeHash: string;
    userCode: string;
    scopes: string[];
    tokenName: string;
    ttl: number;
  }): Promise<void> {
    await this.d1
      .prepare(
        "insert into device_codes (id, device_code_hash, user_code, user_id, status, scopes, token_name, expires_at, created_at) values (?, ?, ?, null, 'pending', ?, ?, ?, ?)",
      )
      .bind(
        `dev_${randomId(12)}`,
        input.deviceCodeHash,
        input.userCode,
        input.scopes.join(" "),
        input.tokenName,
        now() + input.ttl,
        now(),
      )
      .run();
  }

  async deviceCodeByUserCode(userCode: string) {
    return this.d1
      .prepare("select * from device_codes where user_code = ? and expires_at > ?")
      .bind(userCode, now())
      .first<{
        id: string;
        status: string;
        scopes: string;
        token_name: string;
        user_id: string | null;
        device_code_hash: string;
      }>();
  }

  async deviceCodeByHash(hash: string) {
    return this.d1
      .prepare("select * from device_codes where device_code_hash = ? and expires_at > ?")
      .bind(hash, now())
      .first<{
        id: string;
        status: string;
        scopes: string;
        token_name: string;
        user_id: string | null;
        user_code: string;
      }>();
  }

  async setDeviceCodeStatus(id: string, status: string, userId: string | null): Promise<void> {
    await this.d1
      .prepare("update device_codes set status = ?, user_id = coalesce(?, user_id) where id = ?")
      .bind(status, userId, id)
      .run();
  }

  // ---- auth.md agent registrations ----

  async createAgentRegistration(input: { claimTokenHash: string; ttl: number }): Promise<string> {
    const id = `reg_${randomId(16)}`;
    await this.d1
      .prepare(
        "insert into agent_registrations (id, claim_token_hash, status, created_at, expires_at) values (?, ?, 'pending', ?, ?)",
      )
      .bind(id, input.claimTokenHash, now(), now() + input.ttl)
      .run();

    return id;
  }

  async agentRegistrationByClaimHash(hash: string) {
    return this.d1
      .prepare("select * from agent_registrations where claim_token_hash = ?")
      .bind(hash)
      .first<{
        id: string;
        status: string;
        claim_email: string | null;
        user_id: string | null;
        token_id: string | null;
        expires_at: number;
      }>();
  }

  async agentRegistrationById(id: string) {
    return this.d1.prepare("select * from agent_registrations where id = ?").bind(id).first<{
      id: string;
      status: string;
      claim_email: string | null;
      user_id: string | null;
      token_id: string | null;
      expires_at: number;
    }>();
  }

  async updateAgentRegistration(
    id: string,
    patch: {
      status?: string;
      claim_email?: string | null;
      user_id?: string | null;
      token_id?: string | null;
    },
  ): Promise<void> {
    const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (fields.length === 0) {
      return;
    }
    await this.d1
      .prepare(
        `update agent_registrations set ${fields.map(([key]) => `${key} = ?`).join(", ")} where id = ?`,
      )
      .bind(...fields.map(([, value]) => value), id)
      .run();
  }

  async createClaimAttempt(input: {
    registrationId: string;
    attemptToken: string;
    userCodeHash: string;
    ttl: number;
  }): Promise<string> {
    const id = `cla_${randomId(16)}`;
    await this.d1.batch([
      this.d1
        .prepare(
          "update claim_attempts set status = 'expired' where registration_id = ? and status = 'initiated'",
        )
        .bind(input.registrationId),
      this.d1
        .prepare(
          "insert into claim_attempts (id, registration_id, attempt_token, user_code_hash, status, expires_at, created_at) values (?, ?, ?, ?, 'initiated', ?, ?)",
        )
        .bind(
          id,
          input.registrationId,
          input.attemptToken,
          input.userCodeHash,
          now() + input.ttl,
          now(),
        ),
    ]);

    return id;
  }

  async claimAttemptByToken(token: string) {
    return this.d1
      .prepare(
        "select * from claim_attempts where attempt_token = ? and status = 'initiated' and expires_at > ?",
      )
      .bind(token, now())
      .first<{ id: string; registration_id: string; user_code_hash: string }>();
  }

  async completeClaimAttempt(id: string): Promise<void> {
    await this.d1
      .prepare("update claim_attempts set status = 'completed' where id = ?")
      .bind(id)
      .run();
  }
}

// ---- conditional state changes used by the token endpoint ----

export async function claimRegistrationToken(
  d1: D1Database,
  registrationId: string,
  tokenId: string,
): Promise<boolean> {
  const result = await d1
    .prepare("update agent_registrations set token_id = ? where id = ? and token_id is null")
    .bind(tokenId, registrationId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function consumeDeviceCode(d1: D1Database, id: string): Promise<boolean> {
  const result = await d1
    .prepare("update device_codes set status = 'used' where id = ? and status = 'approved'")
    .bind(id)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function tokenExists(d1: D1Database, id: string): Promise<boolean> {
  const row = await d1
    .prepare("select id from tokens where id = ?")
    .bind(id)
    .first<{ id: string }>();

  return row !== null;
}
