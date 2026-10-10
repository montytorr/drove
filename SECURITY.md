# Security

Please report a vulnerability privately, through GitHub's security advisories: [open a draft advisory](https://github.com/montytorr/drove/security/advisories/new). Do not open a public issue for it. Say what you found, how to reproduce it, and what it lets someone do.

Drove launches agents with permission prompts bypassed and relies on its guard hook and on per-seat message signatures to keep workers in bounds, so a way around the guard, or a way to forge a signed control, counts as a security issue.

Only the latest commit on `main` is supported.
