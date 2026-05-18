// T14.1 — Zod schemas for the GitHub REST surface this app consumes.
//
// All shapes use `looseObject` so additive changes from GitHub (new
// fields, new statuses) don't trip parse on old clients. We only pin
// the fields the rest of the app actually reads — keeping the schema
// narrow keeps the runtime cost of validation low for endpoints that
// return tens of thousands of bytes per page.

import { z } from "zod";

export const githubUserSchema = z.looseObject({
  login: z.string(),
  id: z.number().optional(),
  avatar_url: z.string().optional(),
  html_url: z.string().optional(),
  type: z.string().optional(),
});
export type GitHubUser = z.infer<typeof githubUserSchema>;

export const githubRepoSchema = z.looseObject({
  id: z.number(),
  node_id: z.string().optional(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean().optional(),
  owner: githubUserSchema,
  html_url: z.string(),
  description: z.string().nullable().optional(),
  fork: z.boolean().optional(),
  default_branch: z.string(),
  stargazers_count: z.number().optional(),
  forks_count: z.number().optional(),
  open_issues_count: z.number().optional(),
  language: z.string().nullable().optional(),
  pushed_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
});
export type GitHubRepo = z.infer<typeof githubRepoSchema>;

const commitAuthorSchema = z.looseObject({
  name: z.string().optional(),
  email: z.string().optional(),
  date: z.string().optional(),
});

export const githubCommitSchema = z.looseObject({
  sha: z.string(),
  node_id: z.string().optional(),
  html_url: z.string().optional(),
  commit: z.looseObject({
    message: z.string(),
    author: commitAuthorSchema.nullable().optional(),
    committer: commitAuthorSchema.nullable().optional(),
  }),
  author: githubUserSchema.nullable().optional(),
  committer: githubUserSchema.nullable().optional(),
});
export type GitHubCommit = z.infer<typeof githubCommitSchema>;

export const githubBranchSchema = z.looseObject({
  name: z.string(),
  commit: z.looseObject({
    sha: z.string(),
    url: z.string().optional(),
  }),
  protected: z.boolean().optional(),
});
export type GitHubBranch = z.infer<typeof githubBranchSchema>;

export const githubPullRequestStateSchema = z.enum(["open", "closed"]);
export type GitHubPullRequestState = z.infer<typeof githubPullRequestStateSchema>;

const prRefSchema = z.looseObject({
  ref: z.string(),
  sha: z.string(),
  label: z.string().optional(),
});

export const githubPullRequestSchema = z.looseObject({
  id: z.number(),
  number: z.number(),
  state: githubPullRequestStateSchema,
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  user: githubUserSchema.nullable().optional(),
  requested_reviewers: z.array(githubUserSchema).optional(),
  head: prRefSchema,
  base: prRefSchema,
});
export type GitHubPullRequest = z.infer<typeof githubPullRequestSchema>;

export const githubWorkflowRunStatusSchema = z.string();
export const githubWorkflowRunConclusionSchema = z.string().nullable();

export const githubWorkflowRunSchema = z.looseObject({
  id: z.number(),
  name: z.string().nullable().optional(),
  display_title: z.string().optional(),
  run_number: z.number().optional(),
  event: z.string().optional(),
  status: githubWorkflowRunStatusSchema,
  conclusion: githubWorkflowRunConclusionSchema,
  workflow_id: z.number().optional(),
  head_branch: z.string().nullable().optional(),
  head_sha: z.string().optional(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  run_started_at: z.string().nullable().optional(),
  actor: githubUserSchema.nullable().optional(),
});
export type GitHubWorkflowRun = z.infer<typeof githubWorkflowRunSchema>;

/** GitHub's list endpoints for Actions wrap the entries in
 *  `{total_count, workflow_runs}`. Commits / branches / pulls all return
 *  a bare array. Keep both shapes modelled. */
export const githubWorkflowRunListSchema = z.looseObject({
  total_count: z.number().optional(),
  workflow_runs: z.array(githubWorkflowRunSchema),
});

export const githubCommitListSchema = z.array(githubCommitSchema);
export const githubBranchListSchema = z.array(githubBranchSchema);
export const githubPullRequestListSchema = z.array(githubPullRequestSchema);
