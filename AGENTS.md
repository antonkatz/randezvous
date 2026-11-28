# Agent instructions

Rules for any agent working in this repository. Product behavior lives in
`docs/SPEC.md` (canonical), `docs/AGENT_BRIEF.md` (implementation handoff), and
`docs/IMPLEMENTATION_DECISIONS.md` (decisions where the spec is silent). This
file only carries repo-wide working rules; if it ever conflicts with the spec,
the spec wins and this file should be corrected.

## Versioning

- **Bump the version on every commit.** No commit lands without a version bump.
- The version lives in `package.json` (`version`) and must stay mirrored in
  `package-lock.json` (the top-level `version` and the `packages[""]` entry).
  Update all three fields together; `npm install --package-lock-only`
  reconciles the lock file if you prefer.
- Choose the segment by the change in the commit:
  - **patch** — fixes, refactors, tests, docs, and anything else by default;
  - **minor** — a new user-facing feature or behavior change;
  - **major** — a breaking change to the protocol, stored data, or public surface.
- The bump travels **in the same commit** as the change it describes. Never
  create a version-only commit, and never leave a bump for a later commit.
- The UI shows this version as a faded stamp in the top-right corner
  (`src/rdz/app.ts` reads `package.json` at build time), and the e2e suite reads
  it from `package.json` at runtime. Do not hardcode the version anywhere else;
  bumping `package.json` is the only edit needed.
- When in doubt about which segment to bump, bump the patch version and note
  the reasoning in the commit message.
