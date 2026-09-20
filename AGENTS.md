# Deployment

Treat `/deploy` as a request to publish Linty locally from synchronized `main`.
Use the `deploy` skill if available (normally `~/.codex/skills/deploy/SKILL.md`),
and follow [the local release runbook](docs/runbooks/local-releases.md).

Keep feature worktrees intact. Use a clean worktree for local `main`, synchronize
it with `origin/main`, and push its committed changes before building. Honor
branch protection; merge any required PR and synchronize again. Run
`node scripts/release-local.mjs --publish` from that main worktree. The command
tests, signs, notarizes, and publishes locally; do not dispatch GitHub Actions or
enable the remote release workflow as part of deployment. A deployment request
authorizes the release; do not ask for the same publishing permission again.

If the user only asks to inspect or prepare deployment tooling, use `--check` or
`--help` and do not publish. Secrets belong in the local secure environment and
Keychain; never put their values in output, source files, or skill files.
