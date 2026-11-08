import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { evaluateDependabotMerge } from "../scripts/dependabot-auto-merge.mjs";

const sha = "a".repeat(40);
const baseSha = "b".repeat(40);
const repository = "roseshot/r2-share";

function metadata(updateType: string, version: string) {
  return [
    "chore(deps): bump example",
    "",
    "---",
    "updated-dependencies:",
    "- dependency-name: example",
    "  dependency-version: '" + version + "'",
    "  dependency-type: direct:production",
    "  update-type: " + updateType,
    "...",
    "",
    "Signed-off-by: dependabot[bot] <support@github.com>",
  ].join("\n");
}

function fixture(updateType = "version-update:semver-patch", version = "1.2.4") {
  const run = {
    status: "completed", conclusion: "success", event: "pull_request",
    name: "CI", path: ".github/workflows/ci.yml", head_sha: sha,
  };
  const association = { number: 9, head: { sha }, base: { sha: baseSha } };
  const pr = {
    number: 9, state: "open", draft: false, commits: 1,
    user: { login: "dependabot[bot]" },
    base: { ref: "main", sha: baseSha, repo: { full_name: repository } },
    head: { ref: "dependabot/npm_and_yarn/example-1.2.4", sha,
      repo: { full_name: repository } },
    mergeable: true, mergeable_state: "clean",
  };
  const commits = [{
    sha, author: { login: "dependabot[bot]" },
    commit: { message: metadata(updateType, version), verification: { verified: true } },
  }];
  return { run, association, pr, commits, repository };
}

describe("Dependabot auto-merge policy", () => {
  test("allows a verified patch or minor update only after successful CI", () => {
    expect(evaluateDependabotMerge(fixture())).toBeNull();
    expect(evaluateDependabotMerge(fixture("version-update:semver-minor", "1.3.0"))).toBeNull();
  });

  test("rejects major, unknown, and prerelease updates", () => {
    expect(evaluateDependabotMerge(fixture("version-update:semver-major", "2.0.0"))).toContain("patch and minor");
    expect(evaluateDependabotMerge(fixture("security-update", "1.2.4"))).toContain("patch and minor");
    expect(evaluateDependabotMerge(fixture("version-update:semver-patch", "7.1.0-dev.20261103.1")))
      .toContain("Pre-release");
    expect(evaluateDependabotMerge(fixture("version-update:semver-minor", "1.3.0-rc.1")))
      .toContain("Pre-release");
  });

  test("rejects failed CI and a CI run not originating from a PR", () => {
    const failed = fixture();
    failed.run.conclusion = "failure";
    expect(evaluateDependabotMerge(failed)).toContain("successful");
    const push = fixture();
    push.run.event = "push";
    expect(evaluateDependabotMerge(push)).toContain("successful");
  });

  test("rejects stale PR commits, stale base, and non-Dependabot authors", () => {
    const staleHead = fixture();
    staleHead.pr.head.sha = "c".repeat(40);
    expect(evaluateDependabotMerge(staleHead)).toContain("changed");

    const staleBase = fixture();
    staleBase.pr.base.sha = "c".repeat(40);
    expect(evaluateDependabotMerge(staleBase)).toContain("changed");

    const author = fixture();
    author.commits[0].author.login = "other-user";
    expect(evaluateDependabotMerge(author)).toContain("verified Dependabot");

    const unsigned = fixture();
    unsigned.commits[0].commit.verification.verified = false;
    expect(evaluateDependabotMerge(unsigned)).toContain("verified Dependabot");
  });

  test("rejects extra commits, missing dependency metadata, and blocked merges", () => {
    const extraCommits = fixture();
    extraCommits.pr.commits = 2;
    expect(evaluateDependabotMerge(extraCommits)).toContain("exactly one");

    const missing = fixture();
    missing.commits[0].commit.message = "chore: update";
    expect(evaluateDependabotMerge(missing)).toContain("metadata");

    const blocked = fixture();
    blocked.pr.mergeable_state = "unstable";
    expect(evaluateDependabotMerge(blocked)).toContain("clean");

    const unknownPR = fixture();
    unknownPR.pr.user.login = "untrusted";
    expect(evaluateDependabotMerge(unknownPR)).toContain("not an open Dependabot");
  });

  test("rejects mixed grouped dependency updates containing a major upgrade", () => {
    const grouped = fixture();
    grouped.commits[0].commit.message = [
      "chore(deps): bump a and b",
      "",
      "---",
      "updated-dependencies:",
      "- dependency-name: a",
      "  dependency-version: '1.2.4'",
      "  update-type: version-update:semver-patch",
      "- dependency-name: b",
      "  dependency-version: '3.0.0'",
      "  update-type: version-update:semver-major",
      "...",
      "",
      "Signed-off-by: dependabot[bot] <support@github.com>",
    ].join("\n");
    expect(evaluateDependabotMerge(grouped)).toContain("patch and minor");
  });

  test("Dependabot covers application, Go, Docker, and Actions dependencies", () => {
    const config = readFileSync(
      new URL("../.github/dependabot.yml", import.meta.url), "utf8",
    );
    const ecosystems = [...config.matchAll(
      /^  - package-ecosystem: "([^"]+)"\n    directory: "([^"]+)"$/gm,
    )].map(match => [match[1], match[2]]);
    expect(ecosystems).toEqual([
      ["npm", "/"],
      ["gomod", "/download-node"],
      ["docker", "/download-node"],
      ["github-actions", "/"],
    ]);
    expect(config.match(/    commit-message:/g)).toHaveLength(4);
    expect(config).toContain('dependency-name: "vite"');
    expect(config).toContain('dependency-name: "@vitejs/plugin-react"');
    expect(config.match(/update-types: \["version-update:semver-major"\]/g)).toHaveLength(2);
  });

  test("workflow runs after CI rather than with a privileged pull_request_target", () => {
    const config = readFileSync(
      new URL("../.github/workflows/dependabot-auto-merge.yml", import.meta.url), "utf8",
    );
    expect(config).toContain("workflow_run:");
    expect(config).toContain('workflows: ["CI"]');
    expect(config).toContain("pull-requests: write");
    expect(config).toContain("persist-credentials: false");
    expect(config).toContain("uses: actions/checkout@v7");
    expect(config).not.toContain("pull_request_target:");
    expect(config).toContain("scripts/dependabot-auto-merge.mjs");
  });
});
