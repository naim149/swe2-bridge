# Security and private data

SWE2 bridge is experimental. It launches your installed Devin CLI and declared shell checks using the operating-system access of the user who starts Codex. Assignment scope does not create an OS sandbox.

Version 0.2 uses `read`, `edit`, and `edit_check` profiles. Delegated filesystem write handlers enforce explicit owned paths. Client-owned terminal handlers enforce the exact declared command, canonical working directory, executor, and approval policy. `devin_respond` cannot approve an undeclared command. Nevertheless, an allowed shell command can access anything permitted by the OS, and built-in Devin tools such as search do not necessarily pass through bridge filesystem handlers. Use a separate OS/container boundary when comprehensive isolation is required.

Trust is checked for the exact assignment directory using a known native trust record or the caller's explicit acknowledgment. The acknowledgment is a caller decision, not a verified native ACP trust setting, and changes no global trust configuration. Profiles set the session policy; they do not grant deployment, signing, remote-host, or account permissions. Cancellation, deadlines, and failures do not undo changes already made.

The MCP connection uses local stdio. The bridge does not open an HTTP service or provide authentication for remote clients. Devin performs remote inference through your own account; use Devin's current product terms and privacy controls to decide which project data you may submit.

## Artifacts and credentials

The default state directory is `~/.local/share/devin-bridge`. Job artifacts can include prompts, source code, command output, session updates, form answers, approvals, legacy conversation exports, diffs, local paths, and identifiers. The generated local installation and temporary checks belong under the ignored `.local/` directory. Treat both locations as private. Attachments deliberately supply bounded file contents to Devin and should contain only data authorized for that task.

Do not upload raw conversation exports, complete logs, state directories, credential files, or unreviewed diffs to issues or pull requests. Redact tokens, account identifiers, internal URLs, private paths, and project data from a minimal reproduction. Normal CLI authentication should remain in Devin's own storage; no credentials belong in the plugin manifest or source repository.

The bridge creates private job files, but it is not protection against other processes running as the same user or against the worker itself. Checkout and resource locks coordinate bridge jobs sharing the state directory; they do not stop native agents or other programs. Native check records are caller-reported evidence rather than independently executed or verified checks. Git snapshots omit ignored files, external paths, reverted transient changes, and some submodule content; bounded logs and events can also be incomplete. Do not infer security or task acceptance from a completed job alone. Do not share the state directory across users as a multi-user service.

## Reporting a vulnerability

Use GitHub's **Security → Report a vulnerability** action for this repository when private vulnerability reporting is enabled. If that action is unavailable, open an issue asking for a private reporting channel without including the vulnerability details, exploit, credentials, or private artifacts. Wait for a private channel before sending sensitive material.

For ordinary bugs without sensitive details, use a public issue with a sanitized reproduction. Do not test a suspected vulnerability against someone else's workspace, account, or installation.
