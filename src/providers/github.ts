import { runCommand } from './exec.js';
import type { OrchestratorConfig } from '../config.js';

export class GitHubUnavailableError extends Error {}
export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface CreatePullRequestInput {
  title: string;
  head: string;
  base: string;
  body: string;
  draft?: boolean;
}

export interface PullRequestResult {
  number: number;
  url: string;
  htmlUrl: string;
}

const REQUEST_TIMEOUT_MS = 20_000;

async function githubFetch(
  config: OrchestratorConfig,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  if (!config.githubToken) {
    throw new GitHubUnavailableError(
      'GITHUB_TOKEN er ikke satt. GitHub-laget (branch/PR/labels) er utilgjengelig uten det.'
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.githubApiBase}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nokto-agent-orchestrator',
        ...(init.headers ?? {}),
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Utleder owner/repo fra config, med fallback til `git remote get-url origin`. */
export async function resolveRepoRef(config: OrchestratorConfig): Promise<RepoRef> {
  if (config.githubOwner && config.githubRepo) {
    return { owner: config.githubOwner, repo: config.githubRepo };
  }
  const res = await runCommand(['git', 'remote', 'get-url', 'origin'], {
    cwd: config.repoRoot,
    repoRoot: config.repoRoot,
    timeoutMs: 10_000,
    readOnly: true,
  });
  if (!res.ok) {
    throw new GitHubUnavailableError('Fant ikke git remote "origin" for å utlede owner/repo.');
  }
  const url = res.stdout.trim();
  const match = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!match || !match[1] || !match[2]) {
    throw new GitHubUnavailableError(`Klarte ikke tolke owner/repo fra remote URL: ${url}`);
  }
  return { owner: match[1], repo: match[2] };
}

export async function createPullRequest(
  config: OrchestratorConfig,
  ref: RepoRef,
  input: CreatePullRequestInput
): Promise<PullRequestResult> {
  const res = await githubFetch(config, `/repos/${ref.owner}/${ref.repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: input.draft ?? false,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GitHubApiError(
      `PR-opprettelse feilet (${res.status}): ${text.slice(0, 500)}`,
      res.status
    );
  }
  const json = (await res.json()) as { number: number; url: string; html_url: string };
  return { number: json.number, url: json.url, htmlUrl: json.html_url };
}

export async function ensureLabelExists(
  config: OrchestratorConfig,
  ref: RepoRef,
  name: string,
  color: string
): Promise<void> {
  const res = await githubFetch(config, `/repos/${ref.owner}/${ref.repo}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name, color }),
  });
  if (!res.ok && res.status !== 422) {
    const text = await res.text();
    throw new GitHubApiError(
      `Kunne ikke opprette label "${name}" (${res.status}): ${text.slice(0, 300)}`,
      res.status
    );
  }
}

export async function addLabelsToIssue(
  config: OrchestratorConfig,
  ref: RepoRef,
  issueNumber: number,
  labels: string[]
): Promise<void> {
  if (labels.length === 0) return;
  const res = await githubFetch(
    config,
    `/repos/${ref.owner}/${ref.repo}/issues/${issueNumber}/labels`,
    {
      method: 'POST',
      body: JSON.stringify({ labels }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new GitHubApiError(
      `Kunne ikke sette labels (${res.status}): ${text.slice(0, 300)}`,
      res.status
    );
  }
}
