apiVersion: 1

# Security Audit Checklist
# Last Updated: 2026-07-02 (Phase 2 completion)
# Previous Pentest Date: 2026-06-23
# Based on current codebase post-Phase 2 - NOT a pentest snapshot

issues:
  # Security Implemented in Phase 2
  - id: H-1
    category: "Network Security"
    severity: "High"
    status: "✅ Implemented"
    description: "mTLS fingerprint binding with mutual TLS authentication"
    location: "src/services/caService.ts, src/config/index.ts"
    p2_status: "Phase 2 complete"
    remediation: "N/A - security control in place"

  - id: H-2
    category: "Authentication & Authorization"
    severity: "Critical"
    status: "✅ Implemented"
    description: "Admin JWT hardening with email domain restrictions and user ID allowlists"
    location: "src/services/authService.ts:187, src/config/index.ts:115, src/routes/otaAdminRoutes.ts:58"
    p2_status: "Phase 2 complete"
    remediation: "N/A - security control in place"

  - id: M-1
    category: "WebSocket Security"
    severity: "High"
    status: "✅ Implemented"
    description: "WebSocket endpoint removed; no `/ws` in src/ directory"
    location: "N/A - removed in Phase 2"
    p2_status: "Phase 2 complete"
    remediation: "N/A - endpoint removed"

  - id: M-2
    category: "Health Endpoint Protection"
    severity: "Medium"
    status: "✅ Implemented (basic)"
    description: "Public `/health` returns minimal JSON; internal details require `x-internal-health` header"
    location: "src/servers/httpServer.ts:163-198"
    p2_status: "Phase 2 complete"
    remediation: "Rate limit bypass risk - addressed by global rate limiter (P3.3)"

  - id: M-3
    category: "CORS Security"
    severity: "Medium"
    status: "✅ Implemented"
    description: "CORS restricted to explicit `CORS_ALLOWED_ORIGINS` from environment"
    location: "src/servers/httpServer.ts:53-62"
    p2_status: "Phase 2 complete"
    remediation: "N/A - security control in place"

  - id: M-4
    category: "CSR Rate Limit Fallback"
    severity: "Medium"
    status: "✅ Implemented"
    description: "CSR rate limiter with Redis fallback to in-memory store"
    location: "src/middleware/csrRateLimiter.ts, src/config/index.ts"
    p2_status: "Phase 2 complete"
    remediation: "Per-instance store; consider shared store for GA"

  - id: M-5
    category: "Private Keys in VCS"
    severity: "Critical"
    status: "✅ Implemented"
    description: "No private keys or secrets committed to git; all via environment variables"
    location: ".gitignore, .dockerignore, git history"
    p2_status: "Phase 2 complete"
    remediation: "N/A - development practices in place"

  # Security Gaps - Addressed in Phase 3

  - id: M-6
    category: "Pilot OTA Exceptions"
    severity: "High"
    status: "⚠️ Documented (Phase 3 P3.7)"
    description: "Pilot OTA open download via environment flag `PILOT_MODE`"
    location: "src/routes/otaRoutes.ts:73, PILOT_V1_EXCEPTIONS.md"
    p2_status: "Phase 2 documented, remains pilot exception"
    remediation: "Document pilot mode behavior in security checklist"

  - id: M-7
    category: "CSR Multi-Instance Fallback Risk"
    severity: "Medium"
    status: "⚠️ Documented (Phase 3 P3.7)"
    description: "CSR rate limiter uses per-process Redis store; shared store needed for GA"
    location: "src/middleware/csrRateLimiter.ts"
    p2_status: "Phase 2 implemented with known limitations"
    remediation: "Document Redis-backed store requirement in Phase 3 GA section"

  - id: M-8
    category: "Bun Supply Chain / Docker Base"
    severity: "Medium"
    status: "⚠️ Documented (Phase 3 P3.7)"
    description: "Bun-based deployment uses unknown upstream node_modules; Docker base image integrity depends on registry"
    location: "Dockerfile, package.json, bunfig.toml"
    p2_status: "Phase 2 established pattern"
    remediation: "Document base image integrity verification in security checklist"

  # Post-Pilot/GA Phase 3 Follow-ups (Would Go in POST-PILOT_ROADMAP.md)
  # These are documented here for Phase 3 perspective but belong in the roadmap

  # TODO: Future Phase 3/4 items that go in POST-PILOT_ROADMAP.md
  # - Secret rotation procedures
  # - Comprehensive runbooks
  # - End-to-end load testing results
  # - Full test coverage metrics
