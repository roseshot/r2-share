import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BOT = "dependabot[bot]";
const ALLOWED = new Set(["version-update:semver-patch", "version-update:semver-minor"]);
const PRERELEASE = /-(?:alpha|beta|rc|dev|canary|next|nightly)(?:[.\d+-]|$)/i;

/** Decide whether an already-successful CI run may merge the exact Dependabot commit. */
export function evaluateDependabotMerge({ run, association, pr, commits, repository }) {
  if (!run || run.status !== "completed" || run.conclusion !== "success" ||
      run.event !== "pull_request" || run.name !== "CI" ||
      run.path !== ".github/workflows/ci.yml") {
    return "The triggering CI run was not a successful pull request validation";
  }
  if (!association || !pr || pr.number !== association.number ||
      pr.state !== "open" || pr.draft ||
      pr.user?.login !== BOT || pr.base?.ref !== "main" ||
      pr.base.repo?.full_name !== repository ||
      pr.head.repo?.full_name !== repository ||
      !pr.head.ref?.startsWith("dependabot/")) {
    return "The pull request is not an open Dependabot update targeting main";
  }
  if (pr.head.sha !== run.head_sha || pr.head.sha !== association.head?.sha ||
      pr.base.sha !== association.base?.sha) {
    return "The PR head or base changed since the successful CI run";
  }
  if (pr.mergeable !== true || pr.mergeable_state !== "clean") {
    return "The PR is not currently clean and mergeable";
  }
  if (pr.commits !== 1 || !Array.isArray(commits) || commits.length !== 1 ||
      commits[0].sha !== pr.head.sha || commits[0].author?.login !== BOT ||
      commits[0].commit?.verification?.verified !== true) {
    return "The PR does not contain exactly one verified Dependabot commit";
  }

  const message = commits[0].commit.message;
  if (typeof message !== "string" || !message.includes("Signed-off-by: dependabot[bot]")) {
    return "Dependabot commit metadata is missing";
  }
  const block = message.match(/(?:^|\n)---\nupdated-dependencies:\n([\s\S]*?)\n\.\.\.(?:\n|$)/);
  if (!block) return "Dependabot dependency metadata is missing";
  const types = [...block[1].matchAll(/^\s+update-type:\s+(\S+)\s*$/gm)].map(match => match[1]);
  const versions = [...block[1].matchAll(/^\s+dependency-version:\s+['"]?([^\s'"]+)['"]?\s*$/gm)]
    .map(match => match[1]);
  if (types.length === 0 || versions.length !== types.length ||
      types.some(type => !ALLOWED.has(type))) {
    return "Only patch and minor dependency updates are eligible";
  }
  if (versions.some(version => PRERELEASE.test(version))) {
    return "Pre-release dependency updates require manual review";
  }
  return null;
}

async function api(path, token, options = {}) {
  const origin = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(origin + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    throw new Error("GitHub API request failed (" + response.status + "): " + path);
  }
  return response.json();
}

export async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !repository || !eventPath) throw new Error("Missing GitHub Actions environment");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const run = event.workflow_run;
  const associated = run?.pull_requests;
  if (!Array.isArray(associated) || associated.length !== 1) {
    console.log("Skip: CI run does not identify exactly one pull request");
    return;
  }
  const association = associated[0];
  const prefix = "/repos/" + repository;
  const pr = await api(prefix + "/pulls/" + association.number, token);
  const commits = await api(prefix + "/pulls/" + association.number + "/commits?per_page=100", token);
  const reason = evaluateDependabotMerge({ run, association, pr, commits, repository });
  if (reason) {
    console.log("Skip PR #" + association.number + ": " + reason);
    return;
  }

  // A successful CI run for an old base must not merge into a newer main.
  const mainBranch = await api(prefix + "/branches/main", token);
  if (mainBranch.commit?.sha !== association.base?.sha) {
    console.log("Skip PR #" + pr.number + ": main changed after CI validation");
    return;
  }

  // GitHub verifies the expected SHA again at merge time to prevent a race.
  const result = await api(prefix + "/pulls/" + pr.number + "/merge", token, {
    method: "PUT",
    body: JSON.stringify({ sha: pr.head.sha, merge_method: "squash" }),
  });
  if (!result.merged) throw new Error("GitHub did not merge PR #" + pr.number);
  console.log("Merged Dependabot PR #" + pr.number + " after successful CI");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
