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
- 2026-10-25 follow-on: user completed Supabase Dashboard login. The actual project was paused; resumed the existing free project without purchase or upgrade. Authenticated SQL Editor is now usable (plugin connectivity is no longer the deployment gate).
- Exported pre-migration cards/attachment metadata CSV locally outside Git: 44,227 bytes, SHA-256 a84c7a14a023187f12ece40c80e81453c4b9a4c44f411250afabf158e1268763; parsed backup contains 45 cards and 15 attachment metadata records. Storage object binaries are not included in this export.
- Applied the exact reviewed 258-line incremental migration through authenticated SQL Editor; Success receipt observed. Postflight: cards45/attachments15 unchanged; fingerprints 149a9ad059ba937e62265a5eca6e3550 / 36c372db5d6c16a6b514952ff874b1f2 unchanged. New task RPCs exist, RLS enabled, authenticated role has neither direct task SELECT nor RPC EXECUTE. Owner list returns empty tasks/devices as expected before pairing.
- Primary existing application owner has 44 cards and all 15 attachments; other account is an example.com acceptance account with one card. Only primary owner is selected for server allowlist; no broad all-user enablement.
- Cloud PR#2 rechecked at 2026-10-25 16:57:33 Asia/Shanghai: unchanged seed HEAD, no bot/review/reaction or target document addition. No repeated trigger; cloud stays disabled.
- Fresh verification after migration: Node14 + Vitest49 + build integration3 + Python34 all pass, typecheck/lint/diff-check pass. Windows ZIP unpacked without overwrite into LOCALAPPDATA/CloudIdeaBoardReceiver; all7 extracted hashes match. No device token/config or persistent receiver was created before pairing.
- Netlify enablement remains unverified: bounded direct/proxy management requests fail TLS/EOF, and CLI read-back reports no deploy-preview allowlist value. A CLI exit0 with empty output is not treated as a write receipt. No new deployment or original Preview/production replacement was performed. A genuine GitHub Netlify Auth login screen (read-only email permission) is open for the user; authorization not accepted by the agent.
- Existing fixed Preview still has the user's legitimate application login and renders44 records after project resume. No cookies/tokens were extracted or transported to another origin. Official Codex environments URL currently redirects this browser to ChatGPT login; desktop login is not browser authorization.
