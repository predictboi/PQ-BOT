# Polymarket E2E test on polyquest.xyz — handover for a LOCAL session

Run this from **Claude Code on the owner's Mac** (`claude --chrome`, or a Claude Desktop session with the Chrome
extension connected). A cloud session can't do it: polyquest.xyz applies its own geo check from the request IP, and
cloud IPs are US → `polymarketWallet.getComplianceStatus` = `{"tier":"close-only","countryCode":"US"}` (no deposits or
new buys). From the owner's Korean IP the tier should be `allow`.

## Goal
Prove the "one-click Polymarket account" flow end to end and record exactly what happens, as input for the Telegram bot
design: **setup → deposit (Solana USDC) → market BUY → market SELL → withdraw (back to Solana USDC)**.
Record every endpoint, popup, wait time, fee and error.

## Authorization and limits (from the owner)
- The owner explicitly authorizes this test with real funds in their own logged-in account. Budget is **≤ 5 USDC** plus
  SOL network fees only. Don't touch other balances, don't send funds anywhere except the flows below, and don't visit
  unrelated sites.
- Never print or store private keys, the mnemonic, session cookies or Privy tokens.
- If a step fails twice, stop and report. Don't improvise around it.
- Don't trigger browser `alert`/`confirm` dialogs: they freeze the extension.

## Account under test
- Site: https://polyquest.xyz (already logged in in Chrome via **Telegram**, Privy embedded Solana wallet)
- Solana wallet: `CKtfURpE6h4UEP7oWuuh1mrM6BB93kToWHWqTuTdB4cv`. Checked on-chain on 11/5: **5 USDC + 0.04 SOL**.
- Polymarket card on My Page: "Not set up".

## How the site implements it (from the production JS bundle, 11/5)
Setup checklist in the UI, in order. Labels as shown on the page:

| # | UI step | Calls | Runs where |
|---|---|---|---|
| 1 | Connect Solana wallet | Polyquest login | browser |
| 2 | Create trading account | Privy `createWallet()` (embedded **EVM** wallet). External-wallet users first do Privy SIWS (`generateSiwsMessage` → Solana `signMessage` → `loginWithSiws`). Then tRPC `user.syncPrivyIdentity({privyAccessToken, privyUserId, privyEvmWalletAddress, email})` → `polymarketWallet.getOrCreateCurrent` | browser (Privy) → backend |
| 3 | Enable secure signing | `polymarketWallet.getSignerConfig` → `{signerId, policyIds}`. Live config: signerId `y8gljtgsy4tanuvprcm971ot`, policy `oe6lk8sqygsk1td3csengfju`. Then Privy `addSigners({address: evmWallet, signers:[{signerId, policyIds}]})` (**user approval popup**) → `polymarketWallet.markSignerReady` | browser (Privy) → backend |
| 4 | Create Polymarket Safe | `polymarketWallet.deploySafeForCurrentUser` → `safeStatus` (`DELEGATION_REQUIRED` / `FAILED` / ok) | **backend** (relayer-v2.polymarket.com, server-side builder key) |
| 5 | Approve trading contracts | `polymarketWallet.approvePolymarketContracts` | backend |
| 6 | Set up trading wallet | `polymarketWallet.deployDepositWallet` → `transferPusdToDepositWallet` → `approveDepositWalletContracts` (if needed) | backend |

Status is read from `polymarketWallet.getCurrent`: `safeAddress`, `safeStatus`, `approvals[]`,
`depositWalletAddress`, `depositWalletApproved`.

Funds and trading:
- **Deposit:** `getOrCreateBridgeDepositAddress` → `svmDepositAddress` (Polymarket bridge, Solana side). The browser
  builds a SOL or SPL transfer to it and **the user's Solana wallet signs it**. Then
  `recordBridgeFundingAttempt({clientAttemptId, txSignature, amount, tokenSymbol, tokenAddress, tokenDecimals, isNative})`,
  and status comes from `refreshBridgeFundingAttemptsStatus` / `listBridgeFundingAttempts`.
  UI limits: stablecoin minimum `minCheckoutUsd` (≈ $5, checked as `amount < min`, so exactly 5 is allowed). It also
  needs about 0.001 SOL plus ATA rent for the first deposit.
- **Buy:** `polymarket.placeBuyMarketOrder({clientOrderId, outcomeId, amountUsd, maxPrice})` → `status`
  `FILLED` / `REJECTED` / `CANCELLED`. Backend.
- **Sell:** `polymarket.placeSellMarketOrder({clientOrderId, outcomeId, size, minPrice})`. Backend.
- **Readiness:** `polymarket.getTradingReadiness({marketId, side})`; market data from `polymarket.getMarketById({id})` (`outcomesMeta[].tokenId`).
- **Withdraw:** `polymarketWallet.quoteSolanaUsdcWithdrawal({amount})` → `createSolanaUsdcWithdrawal({clientAttemptId, amount})`
  → `localStatus` `SUBMITTED` / `WAITING` / `DETECTED` / `PROCESSING` / `COMPLETED`. **No user signature.** It pays out to
  the logged-in Solana wallet, which must be the connected wallet. Backend.
- **Compliance:** `polymarketWallet.getComplianceStatus` → `tier` `allow` / `close-only` / `block` / `unknown`.
  `block` or `unknown` blocks withdrawals; any tier that restricts new positions blocks deposits and buys.

Implication for the Telegram bot: only steps 2 and 3 (Privy wallet plus signer consent) and the "send from my wallet"
deposit need the browser or the user. Everything else is backend tRPC under the user's session, and the deposit can be
"send USDC to `svmDepositAddress` from anywhere".

## Steps to run
0. **Pre-check.** On polyquest.xyz/myPage, open DevTools → Network (or watch tRPC calls) and confirm
   `getComplianceStatus` returns `tier: "allow"`. If it doesn't, stop and report.
1. **Setup.** My Page → Balances → Polymarket card → **Deposit** → complete every checklist step. Approve the Privy
   prompts; steps 4–6 just need waiting. Record the EVM address, Safe address and deposit-wallet address (from the UI or
   the `getCurrent` response) and the exact text of each popup.
2. **Deposit 5 USDC.** Choose USDC, amount `5`, and approve the Solana transfer. Record the tx signature and the
   `svmDepositAddress`. Refresh until the Polymarket pUSD balance shows it (allow ~15 min) and time it.
3. **Buy.** Pick a liquid Polymarket market on the site (price 0.2–0.8) and place a market BUY of **$2**. Record the
   market, outcome, price, shares and order id.
4. **Sell.** Market SELL the whole position. Record the proceeds and order id.
5. **Withdraw.** Withdraw the full pUSD to Solana USDC. Record the quote, fee and status progression, and the final
   Solana tx (allow ~15 min). If a withdraw minimum blocks it, record the exact message.
6. **Final balances.** Read the Wallet and Polymarket figures on My Page.

## Report back (paste into the cloud ops session for on-chain verification)
```
--- PQ POLYMARKET TEST RESULT ---
solana_wallet_full_address: CKtfURpE6h4UEP7oWuuh1mrM6BB93kToWHWqTuTdB4cv
compliance_tier:
evm_address:
safe_address:
deposit_or_trading_wallet_address:
setup: [step → ok/fail + error text + seconds taken]
deposit: amount / solana tx / svmDepositAddress / time until pUSD arrived / pUSD received
buy: market / outcome / $ / price / shares / order id / status
sell: proceeds / order id / status
withdraw: amount / quote+fee / status progression / solana tx / USDC received / total time
final_balances: wallet / polymarket
popups_seen: [each Privy/wallet prompt + text]
network_calls_seen: [tRPC procedure → status, in order]
errors_or_weirdness:
---
```
The cloud session will then check on Polygonscan and Solscan: Safe deployment and approvals, the bridge deposit landing,
the fills, the withdrawal payout, and the fees lost at each hop.
