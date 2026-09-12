# Security and private data

SWE2 bridge is experimental. It launches your installed Devin CLI using the operating-system access of the user who starts Codex. A task's working directory and scope instructions do not create a sandbox. The worker's capabilities depend on that account, Devin's configured permissions, and workspace trust.

The default bridge configuration uses `accept-edits` and respects workspace trust. Keep those controls appropriate for your workspace. Shell, build, and test commands can require interactive approval that the headless bridge cannot grant; it should surface the block rather than bypass it. Cancellation, deadlines, and failures do not undo changes already made.

The MCP connection uses local stdio. The bridge does not open an HTTP service or provide authentication for remote clients. Devin performs remote inference through your own account; use Devin's current product terms and privacy controls to decide which project data you may submit.

## Artifacts and credentials

The default state directory is `~/.local/share/devin-bridge`. Job artifacts can include prompts, source code, command output, conversation exports, diffs, local paths, and identifiers. The generated local installation and temporary checks belong under the ignored `.local/` directory. Treat both locations as private.

Do not upload raw conversation exports, complete logs, state directories, credential files, or unreviewed diffs to issues or pull requests. Redact tokens, account identifiers, internal URLs, private paths, and project data from a minimal reproduction. Normal CLI authentication should remain in Devin's own storage; no credentials belong in the plugin manifest or source repository.

The bridge creates private job files, but it is not protection against other processes running as the same user or against the worker itself. Checkout locks coordinate bridge jobs sharing the state directory; they do not stop native agents or other programs from changing the checkout. Do not share that state directory across users as a multi-user service.

## Reporting a vulnerability

Use GitHub's **Security → Report a vulnerability** action for this repository when private vulnerability reporting is enabled. If that action is unavailable, open an issue asking for a private reporting channel without including the vulnerability details, exploit, credentials, or private artifacts. Wait for a private channel before sending sensitive material.

For ordinary bugs without sensitive details, use a public issue with a sanitized reproduction. Do not test a suspected vulnerability against someone else's workspace, account, or installation.
