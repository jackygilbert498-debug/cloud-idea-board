# Task dispatch progress

Plan: docs/superpowers/plans/2026-10-25-codex-three-targets.md

- User confirmed all three targets; Mac currently unavailable, prepare install package first.
- Baseline: full Emil dirty tree at 42043a7, no files removed. Windows native dependencies restored; existing Node unit14/14, regression12/12, integration2/2, typecheck and lint passed before feature work.
- Execution: independent file ownership for backend, Python receiver and UI; root coordinates integration and a fresh final review.
- Routing: owner+device+project are immutable; expired work needs_attention and is never silently redelivered.
- Implemented UI, server API/SQL and portable receiver. Independent review fixes and final verification tracked in docs/task-dispatch-acceptance.md.
- Windows real ChatGPT-authenticated Codex execution passed; cloud PR has no receipt yet; Mac package prepared, real device unavailable.
- Production enablement requires the new migration, explicit owner allowlist and limited cloud authorization. No claim of full online three-target acceptance.
- Follow-on: isolated Netlify acceptance deploy 6add330919bacbc7c5f4b111 at codex-acceptance--fy-cloud-idea-board.netlify.app verified (HTML/JS/ZIP200; exact package hash; user API401; runner503 unconfigured). Production and fixed Preview preserved.
- Ruling: do not replace the working Preview/production with an unconfigured task service; use an isolated acceptance alias until real auth, migration and routing pass. Cost if wrong: an extra alias to retire after release, rather than disrupting existing data workflows.
- Existing Preview and acceptance organize API both return AUTH_UNAVAILABLE for a deliberately invalid diagnostic session; exact backend cause unverified. Never classify this as successful real login acceptance.
- Official cloud CLI read-only checks find zero tasks and no accessible repository environment; no made-up ENV_ID or duplicate trigger.
- Supabase plugin exists but is not connected; no usable management authorization found in the supplied project scope. No SQL bypass or credential transport was introduced.
- Bounded thread heartbeat automation-2 created ACTIVE (hourly, count8), quiet on unchanged state, to resume safe work after real external changes. See docs/交付结果与明日验收.md for user-facing result.
