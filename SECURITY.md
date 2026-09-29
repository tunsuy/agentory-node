# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `0.1.x` (`@agentoryhq/node` and related packages) | Yes |
| Older / unpublished forks | Best effort only |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems (credential leaks, unsafe write paths, RCE in adapters, etc.).

Prefer one of:

1. **GitHub Security Advisories** for this repository:  
   https://github.com/tunsuy/agentory-node/security/advisories/new  
2. Or email the maintainers listed on the GitHub org/profile for `tunsuy` with subject `[agentory-node security]`.

Include:

- Affected package and version
- Impact (read local files, write config, token exposure, …)
- Reproduction steps or proof-of-concept (no real production secrets)
- Whether a fix is already known

We aim to acknowledge reports within **7 days** and to coordinate disclosure after a fix or mitigation is available.

## Security expectations for contributors

- Never commit API keys, node tokens, `.env` files, or private transcripts.
- Adapters must only write paths declared by their design (e.g. project `.mcp.json` / `.cursor/`); no default home-directory crawl.
- Align / config write APIs must refuse work unless the control plane plan is **confirmed**.
- Prefer masking secrets in logs and transcript helpers.
