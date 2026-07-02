# Bun Runtime Security Notes

## Version Policy
- Pilot v1: Pinned to Bun 1.1.0
- Upgrade policy: security patches only, tested in staging
- No auto-updates

## Known Risks
- No permission model (unlike Deno)
- Native Zig code less audited than Node.js C++
- No formal LTS program

## Mitigations
- Non-root container user (bunjs)
- Lifecycle scripts disabled by default
- Railway private networking for databases
- MongoDB Atlas IP allowlist

## Monitoring
- Subscribe: https://github.com/oven-sh/bun/security/advisories
- Review lockfile on dependency changes

