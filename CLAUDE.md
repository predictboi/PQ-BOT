# PQ-BOT — Polyquest 운영 봇

## Brand name
- The product is **Polyquest** — capital **P**, the rest lowercase. Never "PolyQuest". All-caps "POLYQUEST" only as a logo/wordmark treatment.

## Hard rules (see docs/HANDOFF.md)
1. **User flow only.** Market creation, bets and resolution go through the same tRPC calls the web frontend makes (`quest.draft → confirmDraftLslmsr`, `betting.draftLslmsr → confirm/confirmSell`, `quest.updateStatus`). Never send LS-LMSR program instructions directly, never touch the DB. On-chain is read-only plus plain SOL/USDP transfers (funding/sweep).
2. **One mnemonic, derived wallets.** index 0 FUNDER, 1 CREATOR, 2..31 TRADER-01..30 (`m/44'/501'/{i}'/0'`). `state/addresses.json` holds addresses only. Never write private keys or the mnemonic to the repo, logs, or chat.
3. **Privileged keys stay off the always-on server.** `MASTER_SECRET_KEY`, `ADMIN_SECRET_KEY`, `RENDER_API_KEY`/`RAILWAY_TOKEN` are for one-off actions from a cloud session; the server only gets `MNEMONIC`, `RPC_URL`, `DASHBOARD_TOKEN`, `PUBLIC_BASE_URL` (+ optional Gemini/Anthropic keys).

## Dev
`npm install` · `npm test` · `npm start` (supervisor + dashboard on :8787) · `DRY_RUN=1 npm start` for no-signing runs. Layout and agents: README.md.
