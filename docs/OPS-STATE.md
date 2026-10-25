# PQ-BOT 운영 현황 · 세션 인수인계 (2026-10-25 기준)

> 새 세션은 이 문서 → `CLAUDE.md`(하드 룰) → `README.md`(구성) 순서로 읽고 이어서 운영한다.
> 비밀값은 이 문서에 없다. 전부 환경 Secrets(env)로만 다룬다. 사용자 보고는 **한국어**.

## 1. 하드 룰 요약 (CLAUDE.md / docs/HANDOFF.md)
- **유저 플로우만:** 마켓 생성·베팅·정산·수령은 프론트가 쓰는 tRPC 그대로 (`quest.draft→confirmDraftLslmsr`, `betting.draftLslmsr→confirm`, `quest.updateStatus`, `betting.createClaim→confirmClaim`, `quest.createClaimFee→confirmClaimFee`). LS-LMSR 프로그램 ix 직접 전송·DB 직접 수정 금지. 온체인은 읽기 + 단순 SOL/USDP 송금만.
- **어드민 키 사용 범위 (사용자 명시 허용):** 크리에이터 승격(`user.batchUpdate`), 마켓 닫기(`quest.closeLslmsrMarket`), INVALID 퀘스트 삭제(`quest.batchDelete`). 상시 서버에는 절대 올리지 않음 → 클라우드 세션에서만.
- **레일웨이는 읽기 전용** (로그·배포 조회만, 아무것도 수정 금지).
- 비밀값(니모닉·키·토큰) 출력·커밋 금지.
- PR은 사용자 위임으로 내가 만들고 머지까지 한다. Render는 main 머지 시 자동 배포.

## 2. 인프라
| 항목 | 값 |
|---|---|
| 봇 서버 (Render) | https://polyquest-bot.onrender.com · service `srv-dbcf3mnf3r2c73crfa10` · autoDeploy on main |
| 대시보드 API | `/api/overview`, `/api/markets`, `/api/trades?hours=24`, `/api/wallets`, `/api/reports/<agent>` (헤더 `Authorization: Bearer $DASHBOARD_TOKEN`) |
| Polyquest 백엔드 | `https://solana-stg.polyquest.xyz` (API) · 프론트 `https://polyquest.xyz/quests/<id>` |
| Railway (읽기) | GraphQL `https://backboard.railway.com/graphql/v2`, 헤더 `Project-Access-Token: $RAILWAY_TOKEN` · environment `4c315312-887d-449e-8ddf-417464a9e42d` · 서비스 `solana-staging-polyquest`(백엔드), `polyquest-worker` · 로그: `deploymentLogs(deploymentId, filter, limit, startDate, endDate)` — 교체된 배포 ID로도 과거 로그 조회 가능 (`deployments(input:{serviceId, environmentId})`) |
| Sentry (MCP) | org `polyquest`, project `polyquest-webapp` — 백엔드/프론트 오류 묶음 조회 |
| LS-LMSR 프로그램 | `4tjbrvyzZ4PVuCnLKhrbbpcKd4ghnT6xxWPLQ2Mav68z` · PDA: market `['market', questIdLE32]`, vault `['vault', market]`, position `['position', market, owner]` |
| 세션 env (이름만) | `MNEMONIC`, `RPC_URL`, `DASHBOARD_TOKEN`, `MASTER_SECRET_KEY`, `ADMIN_SECRET_KEY`, `RENDER_API_KEY`, `RAILWAY_TOKEN` |

## 3. 지갑 (니모닉 1개 파생, `m/44'/501'/{i}'/0'`)
- 0 FUNDER `3m2ph…NCN` · 1 CREATOR `Gws6p…BRGa4` (표시명 **Felix S**) · 2–31 TRADER-01..30 · 32 CREATOR-02 `Dvmv…5ra8` (표시명 **yuna00**)
- 트레이더 표시명: `bin/rename-wallets.js` (salt v1)로 설정 완료 (jordan.w, chainfan …)
- MASTER(`JCGU…`, env `MASTER_SECRET_KEY`): 10/24 기준 약 0.48 SOL / 8,329만 USDP → USDP 보충원. **SOL은 거의 없음.**
- 2zfBHp…HnPB 로 10,000 USDP 송금(사용자 요청, 10/23) — 봇 지갑 아님.

## 4. 에이전트 (Render 상시, 크론 UTC)
| 에이전트 | 주기 | 내용 |
|---|---|---|
| trader | 상시 루프 | 오가닉 거래(페르소나 whale3/active8/casual19, ~800건/일, 조용한 마켓 25% 커버) |
| oddsSync | 매시 :07 | Polymarket 가격 ±밴드로 맞춤 (매수만 → USDP가 포지션으로 묶임, 하루 ~30–44만) |
| funding | 30분마다 | 트레이더 SOL<0.03 → +0.04, USDP<500 → +5,000 (FUNDER 예비 0.2 SOL 유지) |
| creator | 6시간마다 | 카테고리 목표 80개 유지, 시드 40k–70k 랜덤, 카테고리 담당 분배(CREATOR / CREATOR-02) |
| resolver | 매일 00:30 | Polymarket 해결 → 크리에이터 세션으로 `quest.updateStatus SUCCESS/REVOKE` → 승리 지갑 수령 → 크리에이터 수수료 |
| reporter | 매시 :03 | 스냅샷·일간 리포트 |

카테고리 목표(합 80): Politics 10 · Sports 15 · Crypto 12 · Economics 12 · Culture 8 · Science 7 · Social 8 · Other 8.

## 5. 마켓 닫기 절차 (클라우드 세션 전용, 어드민 키)
```
node bin/close-markets.js --quest <id,id>      # --dry 로 상태만
```
수령(유저 플로우) → 크리에이터 수수료(시더만 서명 가능, 남아 있으면 중단) → 어드민 `closeLslmsrMarket` (백엔드가 남은 포지션 전부 close·승리금/렌트 지급 + 플랫폼 수수료 claim + vault sweep, 3회 재시도).
확인: `readMarket(q) === null`, position PDA 없음, claimable 0건.
- 백엔드 반영 배포: 4b8ded1f(플랫폼 수수료 자동), 4497e4b9(포지션 자동 close), f0475130(수수료 반영 대기), c4dfebec(형제 row claimed 처리).
- 첫 close 호출이 마지막 단계에서 실패(0x2b)해도 재시도로 닫힘 — 스크립트가 처리.

## 6. 현재 상태 (10/25 13:17 UTC)
- 라이브 80/80, 인밴드 80/80, 24h 볼륨 0 마켓 없음. 24h 938건 중 935 성공, 71k USDP.
- 정산·닫기 완료: 초기 12개, 900065, 900064.
- 잔액 추이: SOL 합계 3.83(10/23) → 3.39(10/24) → 3.24(10/25 05:30). 초기 소모는 대부분 포지션 렌트(정산·close 시 회수). USDP 합계 ~125만, 오즈싱크로 계속 감소.

## 7. 진행 중 / 대기
- **10/25 마감 5개 정산 후 클로즈** (사용자 요청): 900055 레알-바르사, 900084 Ali G, 900104 Iotova, 900114 Brighton, 900119 Clayface. 리졸버 10/26 00:30 → **01:00 UTC에 클로즈 실행** (이전 세션에 send_later 예약 trig_015Fw2rXbRvtHDAXP5bH3vLt — 그 세션이 살아 있으면 거기서 실행됨. 새 세션이 맡으면 중복 실행 주의: 먼저 `--dry`로 이미 닫혔는지 확인). 미정산분은 다음 날 01:00 재확인.
- **데브 전달 완료/대기:** 패배 포지션 DB row가 `hasUnclaimed=true`로 남는 문제(저우선순위, UI 영향 없음).
- **제안만 하고 미결정:** (1) FUNDER에 SOL 2–3 추가 (트레이더 SOL 최소치 도달 대비 — 소모가 줄어 급하지 않음), (2) 오즈싱크를 "반대쪽 매수" 대신 "보유 지분 매도"로 바꿔 USDP 묶임 줄이기, (3) 마스터 → 트레이더 USDP 보충.
- `quest.draft` P2028(트랜잭션 타임아웃) 재발 여부: 크리에이터가 새로 만들 때 확인 (10/25 3개 생성은 정상).

## 8. 자주 쓰는 명령
```
npm test
node bin/fund.js --balances                    # 전체 잔액
node bin/claim.js [--quest id]                 # 수령 재시도
node bin/close-markets.js [--quest id] [--dry] # 닫기
node bin/rename-wallets.js --dry               # 표시명
node bin/seed-topup.js --dry                   # 시드 보충 계획
```
