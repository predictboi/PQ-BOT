# Polyquest 봇 빌드 핸드오프 (최종본) — 크리에이터 봇 + 트레이딩 봇 + Polymarket 오즈 싱크

> **이 문서의 용도**: 새 Claude Code 세션에서 Polyquest(Solana 스테이징) 운영 봇을 **처음부터 빌드**하기 위한 단일 진실 소스. Part A = 무엇을 어떻게 만들지(빌드 스펙), Part B = 플랫폼 레퍼런스(검증된 API/주소/수학/교훈).
> **비밀값(니모닉·개인키·API 키 박힌 RPC URL)은 이 문서에 절대 없다.** 전부 Environment Secrets / git-ignored `.env`로만 다룬다.

---

## ‼️ 최상위 원칙 (CRITICAL — 위반 금지)

### 원칙 1. 모든 플랫폼 동작은 "프론트에서 유저가 하듯이" 실제 유저/크리에이터 플로우로만
**마켓 생성 · 베팅(매수/매도) · 종료(해결)** 세 가지 전부:

> **지갑 로그인 → 프론트가 호출하는 바로 그 백엔드 API(tRPC)를 순서대로 호출 → 서버가 준 tx를 지갑으로 서명 → confirm → 백엔드가 온체인 확정**

- ❌ **어드민 플로우 금지** — 관리자 전용 단축 경로로 마켓/베팅/종료 처리 금지. (유일한 예외: §A3의 *크리에이터 승격*은 플랫폼이 정한 어드민 페이지 기능이므로 **사람이 1회** 수행)
- ❌ **백엔드만 금지** — DB 직접 수정, 내부 엔드포인트로 상태만 바꾸기 금지.
- ❌ **온체인만 금지** — 프로그램 ix(`initializeMarket`/`buyShares`/`sellShares`/`resolve` 등)를 직접 빌드·서명·전송 금지. 기존 `mainnet-lib.mjs`·`close-max.mjs`·`settle-all.mjs`는 **새 봇에서 쓰지 않는다**(읽기용 `src/client.js`의 `decodeAccount`만 허용).
- 왜: 온체인만 하면 백엔드/프론트에 인덱싱이 안 되고, 한쪽만 건드리면 두 상태가 어긋나 **복구 불능**이 된다. 실제 사례: JCGU로 온체인 resolve를 먼저 → 백엔드 `quest.updateStatus→SUCCESS`가 `AlreadyResolved(0x0)`로 영구 500 (§B6-11).
- 허용되는 "순수 지갑 작업": SOL/USDP **송금(펀딩·회수)**은 플랫폼 동작이 아니므로 일반 지갑 전송으로 한다. **온체인 읽기**(잔액·마켓 계정 디코드)도 허용.

### 원칙 2. 키는 절대 잃어버리지 않는다
- **니모닉 1개가 루트**. 모든 지갑(펀더·크리에이터·트레이더 30개)은 거기서 **결정적으로 파생**(§A2). 파일이 다 날아가도 니모닉만 있으면 100% 복구.
- 니모닉은 **① Environment Secrets(클라우드 세션) ② Railway Variables(봇 배포) ③ 사용자 본인 보관(패스워드 매니저)** 세 곳에. 코드/레포/채팅 로그에는 절대 안 둔다.
- 생성 즉시 사용자에게 **복사본 전달**(§A2 절차). 세션 컨테이너는 idle 시 반납되어 git-ignored 파일이 전부 사라진다(이미 두 번 겪음, 서브월렛 키 분실로 자산 회수 불가 사례 발생).

---

# Part A — 빌드 스펙

## A0. 어디서 빌드하나
- **새 Claude Code 세션**에서 진행 (Secrets는 새 세션부터 주입되므로). 레포는 동일 `predictboi/Predictboi`, 새 디렉터리 `bots/polyquest-bot/`.
- 세션 시작 **전에** 환경(타이틀바 환경 메뉴 → Edit → Secrets)에 아래를 등록:
  ```
  MNEMONIC            = <12/24 단어>            # 루트 (§A2)
  RPC_URL             = <QuickNode mainnet URL>  # API 키 포함 = 비밀
  POLYQUEST_API_BASE  = https://solana-stg.polyquest.xyz
  GEMINI_API_KEY      = <선택: 썸네일 생성용>
  ```
- 재사용할 기존 코드(검증됨): `tools/solana-lslmsr-test/polyquest.mjs`(유저 플로우 클라이언트), `tools/lslmsr-test/src/lslmsr.js`(LS-LMSR 수학), `tools/lslmsr-test/src/gen-image.js`(썸네일), `tools/solana-lslmsr-test/src/client.js`(온체인 **읽기** 디코더).
- 봇 런타임은 세션 컨테이너에 두지 말고 **Railway 서비스**(프로젝트 `polyquest` / env `solana-staging`에 이미 `polyquest-worker` 서비스 존재)로 배포해 24/7 구동. 개발·검증은 Claude Code에서, 상시 실행은 Railway에서.

## A1. 요구 기능 (사용자 요구사항 원문 반영)
| # | 기능 | 요약 |
|---|---|---|
| 1 | **크리에이터 봇** | 카테고리별로 예측 마켓을 올리고 관리하는 지갑 1개. 토픽은 Polymarket 실마켓 참고 또는 직접 리서치. **카테고리당 최소 5개**, **스포츠·경제·정치 등 메이저는 10개**까지 운영. USDP 담보. |
| 2 | **트레이딩 계정 30개** | 각 마켓 볼륨을 올리는 30개 지갑. 키 전부 보관 + 사용자에게 복사본. |
| 3 | **오즈 싱크** | **1시간마다** 모든 마켓 점검: 매핑된 Polymarket 마켓의 현재 odds와 우리 LS-LMSR 가격을 비교해 트레이더 지갑으로 거래해서 비율 맞춤. |
| 4 | **전부 유저 플로우** | 원칙 1. 프론트가 하는 콜을 그대로, 순차적으로. |

## A2. 지갑 체계 (니모닉 1개 → 전부 파생)
**경로**: Solana 표준 BIP44 `m/44'/501'/{i}'/0'` (Phantom/Solflare 호환 → 사용자가 니모닉을 Phantom에 넣으면 **모든 계정을 직접 볼 수 있음** = 최고의 백업).

| index | 역할 | 비고 |
|---|---|---|
| 0 | **FUNDER(트레저리)** | 사용자가 SOL·USDP를 여기로 1회 입금. 모든 펀딩·회수의 허브. |
| 1 | **CREATOR** | 마켓 생성/관리. `/admin`에서 크리에이터 승격 필요(§A3). |
| 2 ~ 31 | **TRADER 01~30** | 볼륨 + 오즈 싱크 거래. |

```js
// src/wallets.js  (deps: bip39, ed25519-hd-key, @solana/web3.js)
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
const seed = bip39.mnemonicToSeedSync(process.env.MNEMONIC.trim()).toString('hex');
export const wallet = (i) => Keypair.fromSeed(derivePath(`m/44'/501'/${i}'/0'`, seed).key);
export const FUNDER = () => wallet(0), CREATOR = () => wallet(1), TRADER = (n) => wallet(1 + n); // n = 1..30
```

**키 보관/전달 절차 (Day-0, 1회)**
1. 니모닉 생성: 봇이 `bip39.generateMnemonic(256)`로 생성 **또는** 사용자가 직접 생성(Phantom/`solana-keygen new`) — 둘 중 하나. 봇이 생성하면 scratchpad 파일로 저장해 **SendUserFile로 사용자에게 1회 전달**하고 즉시 삭제.
2. 사용자: 패스워드 매니저 보관 + Environment Secrets + Railway Variables에 `MNEMONIC` 등록.
3. `bin/init-wallets.js` 실행 → `state/addresses.json`(index·역할·**주소만**) 생성 → **커밋 OK**(비밀 아님).
4. 검증: 사용자가 Phantom에 니모닉 import → index 0/1/2 주소가 `addresses.json`과 일치하는지 확인. **일치 확인 전에는 펀딩 금지.**
5. 절대 하지 말 것: `subwallets.json`류의 **개인키 파일 생성 금지**(필요 없음 — 전부 파생). `.gitignore`에 `.env*`, `*.key`, `*secret*` 유지.

## A3. 크리에이터 승격 (유일한 어드민 작업, 사람이 1회)
1. 봇: CREATOR(index 1)로 플랫폼 **로그인 1회**(§B4 로그인 핸드셰이크) → 유저 row 생성. 선택: `setEmail`.
2. 사람: **컨트랙트 마스터 지갑**으로 https://solana-stg.polyquest.xyz/admin 접속 → 해당 주소 **User → Creator 승격**. (마스터 = 레지스트리 owner **JCGU**(`JCGUheK5…QmdTfX`); 승격 권한이 684J에 있으면 684J. 로그인 되는 쪽으로.)
3. 봇: 승격 확인 — `quest.draft`가 권한 에러 없이 `encodedTx`를 반환하면 OK (dry: draft만 하고 confirm 안 하면 마켓 안 생김… 단 draft row가 남을 수 있으니 실제 1개 생성으로 확인 권장).

## A4. SOL / USDP 예산 (구동에 필요한 양)
Solana 비용 구조: 서명당 5,000 lamports + 우선수수료(25k µLamports/CU × ~200k CU ≈ **0.000005 SOL**, 사실상 0) + **계정 rent**(토큰 ATA ≈ 0.00204 SOL, 포지션 PDA ≈ 0.002~0.003, 마켓+볼트 ≈ 0.01). rent는 계정 닫으면 회수됨.

| 항목 | 산식 | 권장 |
|---|---|---|
| CREATOR | 마켓당 ≈ 0.01 SOL(rent) + fee. 50~60개 마켓 → ~0.6 | **1.5 SOL** |
| TRADER ×30 | USDP ATA 0.002 + 마켓당 포지션 0.0025 × ~60개 ≈ 0.15 + fee | **0.25 SOL/지갑 → 7.5 SOL** |
| FUNDER 예비 | 자동 top-up(임계 0.05 미만 시 +0.1) | **3 SOL** |
| **합계** | | **≈ 12 SOL** (여유 포함; 실사용은 절반 이하 예상, rent 회수 가능) |

USDP (6 decimals, 민트권한 JCGU — 부족하면 추가 발행 가능):
| 항목 | 산식 | 권장 |
|---|---|---|
| 마켓 시드 | 마켓당 15,000 USDP(기존 테스트 기준; `alpha 0.05`) × 60개 | **900,000 USDP** |
| 트레이더 운용 | 지갑당 50,000 USDP × 30 | **1,500,000 USDP** |
| **합계** | | **≈ 2.5M USDP** → FUNDER로 입금 (684J가 ~9.9M, zJBEn이 500M 보유 중) |

현재 684J SOL은 0.18로 부족 → **사용자가 FUNDER(index 0)에 ~12 SOL + ~2.5M USDP 입금** 후 시작. `funding.js`가 FUNDER→각 지갑 분배(SOL·USDP 일반 전송) + 주기적 top-up.

## A5. 아키텍처
```
bots/polyquest-bot/
  package.json            # type: module
  .env.example            # 키 이름만 (값 없음)
  src/
    config.js             # 주소·API base·파라미터(alpha, seed, 밴드, 카테고리 목표 수)
    wallets.js            # §A2 파생
    client/polyquest.js   # ← tools/solana-lslmsr-test/polyquest.mjs 이식: login/trpc/createMarket/trade/verifyBetLanded/updateStatus/read helpers
    lslmsr.js             # ← tools/lslmsr-test/src/lslmsr.js (순수 수학)
    chain/read.js         # ← src/client.js decodeAccount: 마켓 계정 q/alpha 읽기 (읽기 전용)
    polymarket.js         # Gamma/CLOB 공개 API 읽기 (§A7)
    research.js           # 카테고리별 토픽 선정 → 마켓 스펙 생성 (§A6)
    images.js             # 썸네일 생성(Gemini) + 공개 URL 호스팅 (§A6)
    creator.js            # 카테고리별 목표 수 유지, 생성(유저 플로우), 해결(유저 플로우)
    trader.js             # 30지갑 볼륨 생성 (§A8)
    oddsSync.js           # 1시간 주기 PM odds 매칭 (§A7)
    funding.js            # FUNDER→지갑 SOL/USDP 분배·top-up·회수
    util.js               # withTimeout, retry, finalized-read, 로그/JSONL
  state/
    addresses.json        # index·역할·주소 (커밋 OK)
    markets.json          # questId ↔ {category, polymarket{conditionId,slug,tokenIds}, answers[{id,title}], endDate, status}
  bin/
    init-wallets.js  fund.js  run-creator.js  run-trader.js  run-odds-sync.js  resolve-check.js  status.js
  reports/                # JSONL 거래 로그, 시간별 스냅샷 (git-ignored)
```
런타임: 하나의 프로세스에서 `node-cron`으로 스케줄 (creator 보충 6h, oddsSync **매시 :07**, trader 상시 루프, resolve-check 매일) 또는 Railway cron 서비스로 분리. 모든 네트워크 await는 `withTimeout` + 재시도 + **confirm 실패 시 `verifyBetLanded` 재검증**.

## A6. 크리에이터 봇 — 마켓 생성/관리
**목표 수**: `config.categoryTargets = { 스포츠:10, 경제:10, 정치:10, <기타 카테고리>:5 … }` — 카테고리 목록은 플랫폼에서 가져온다(tRPC에 `category.*` 프로시저가 있는지 프로브하거나 프론트 네트워크 탭 확인; `quest.draft`의 `categoryId`에 사용).

**루프 (6시간마다 + 수동 트리거)**: 카테고리별 라이브 마켓 수(`quest.listByWallet` CREATOR, status APPROVED, endDate 미래) < 목표 → 부족분만큼 생성.

**토픽 소싱 (research.js)**
1. Polymarket Gamma API에서 카테고리 태그별 활성 이벤트 조회(§A7) → 거래량·유동성 상위, 종료일 3일~90일, Yes/No 바이너리 우선.
2. 중복 방지: `markets.json`의 polymarket conditionId 기준.
3. 직접 리서치 토픽(옵션): 한국 이슈 등 PM에 없는 주제는 사람이 `topics/manual.json`에 넣으면 생성.
4. 마켓 스펙: `title`(한국어, 명확한 기준·날짜 포함), `description`(해결 기준 출처 명시), `answers:[{title:'예'},{title:'아니오'}]`, `endDateISO`(PM endDate와 동일), `openingRatios` = **생성 시점 PM odds**(예: Yes 0.62 → `['62','38']`), `seed:'15000'`, `alpha:'0.05'`, `tokenId:4`(USDP), `collateralKind:'pegged'`, `creatorFeePercent:0.02`, `categoryId`.

**썸네일 (images.js)**: Gemini `gen-image.js`(프리셋 `market`, 텍스트 금지) → 512×512 JPG → 공개 URL 필요 → 공개 레포(`predictboi/token` raw.githubusercontent, 이미 토큰 로고에 사용 중)에 push 하거나 S3/R2. `imageUrl`로 전달. PM 이미지 무단 사용 금지.

**생성 = 유저 플로우** (`client.createMarket`): `quest.draft` → `signEncodedTx(CREATOR)` → `quest.confirmDraftLslmsr`. 생성 후 `quest.detail`로 `answers[].id` 저장(베팅·해결에 필요). `markets.json` 갱신.

**해결 = 유저/크리에이터 플로우** (`resolve-check.js`, 매일): PM 마켓이 `closed`+해결됨 → 승리 outcome 매핑 → `quest.updateStatus({ id, data:{ status:'SUCCESS', finalAnswerId:<예 or 아니오 id> } })` (백엔드가 온체인 resolve까지 수행). PM이 무효/취소 → `status:'REVOKE'`. **절대 온체인 resolve를 먼저 하지 말 것.** LSLMSR엔 `FINISH` 단계 없음.

## A7. 오즈 싱크 (1시간마다)
**Polymarket 공개 API (읽기, 키 불필요)** — 빌드 시 필드명 재확인:
- 이벤트/마켓: `GET https://gamma-api.polymarket.com/events?tag_slug=<politics|sports|…>&active=true&closed=false&limit=100` → `events[].markets[]` : `question`, `conditionId`, `slug`, `outcomes`(JSON 문자열 `["Yes","No"]`), `outcomePrices`(JSON 문자열 `["0.62","0.38"]`), `clobTokenIds`(JSON 문자열), `endDate`, `closed`, `volume`, `liquidity`.
- 실시간 가격: `GET https://clob.polymarket.com/midpoint?token_id=<Yes tokenId>` → `{ mid }` (또는 `/price?token_id=&side=buy`).
- 태그 목록: `GET https://gamma-api.polymarket.com/tags`.

**알고리즘 (마켓마다)**
1. 목표 `p* = PM Yes 확률` (midpoint). 우리 현재 `p = quest.detail.answers[예].percent` (또는 온체인 `decodeAccount`로 q·alpha 읽어 `LsLmsr.prices()` — 더 정확).
2. `|p − p*| ≤ 0.02` → 스킵. 아니면 방향 결정: `p < p*` → **예 매수**, `p > p*` → **아니오 매수**(매도보다 매수가 단순·안전; 포지션 있으면 매도도 가능).
3. 필요 금액: 로컬 `LsLmsr` 모델(현재 q, alpha)에 대해 이분탐색 — `buyAmount(i, x)` 후 가격이 `p*`에 도달하는 최소 `x`. **시간당 이동 상한**(예: 한 번에 최대 0.08 또는 금액 상한) 적용해 오버슈팅·비용 폭주 방지. 금액을 트레이더 2~4개 지갑에 분할.
4. 실행 = 유저 플로우 `client.trade(sess, kp, {questId, answerId, spent, kind:'BUY', inputTokenAddr: USDP_MINT})`. 2초 간격. 실패 시 verify.
5. 로그: `reports/odds-sync.jsonl`에 `{t, questId, pBefore, pTarget, pAfter, spent, wallets}`.
6. PM 매핑이 없는 수동 토픽은 `topics/manual.json`의 `targetOdds`(사람이 지정) 또는 스킵.

## A8. 트레이딩 봇 (볼륨 생성, 30지갑)
- 기존 `soak24.mjs` 로직 계승하되 **목표가 = PM odds**: 가격이 `p*` ± 밴드(0.05) 안에 머물도록 **양방향 균형 매매**(예 매수 ↔ 아니오 매수 교대, 보유분 있으면 매도 섞기)로 볼륨만 올리고 드리프트는 oddsSync가 교정.
- 파라미터(config): `tradesPerHourPerMarket`(기본 20~40), 금액 버킷 `base:[20,120]`, `flux:[300,700]`(확률 0.15), `BUY_BIAS 0.52`, 지갑 라운드로빈, `SNAP_EVERY 15`, 120틱마다 재로그인.
- 세션: 지갑 30개 각각 로그인(쿠키 jar) — 유저 row 자동 생성. 세션 만료 시 재로그인.
- 잔액 가드: 지갑 USDP < 500 → FUNDER에서 보충(또는 보유 포지션 매도), SOL < 0.05 → +0.1.
- 종료된 마켓(SUCCESS/REVOKE)은 즉시 거래 대상에서 제외.

## A9. 운영·리포팅
- `bin/status.js`: 지갑별 SOL/USDP, 카테고리별 라이브 마켓 수, 마켓별 `p vs p*`, 24h 볼륨, 실패율.
- 알림(옵션): 실패율 >10%, 잔액 부족, PM 매핑 끊김 → 로그/슬랙.
- 회수(`bin/sweep.js`, 선택): 트레이더 → FUNDER로 USDP/SOL 일반 전송 (키는 파생이라 언제든 가능).

## A10. Day-0 체크리스트 (순서 엄수)
1. 환경 Secrets 등록(`MNEMONIC`, `RPC_URL`, `POLYQUEST_API_BASE`, 선택 `GEMINI_API_KEY`) → **새 세션 시작**
2. `bin/init-wallets.js` → `state/addresses.json` 커밋 → 사용자가 Phantom import로 **주소 일치 검증**
3. 사용자: FUNDER(index 0)에 **~12 SOL + ~2.5M USDP** 입금
4. CREATOR 로그인 1회 → 사람이 `/admin`에서 **Creator 승격** → 생성 권한 확인
5. `bin/fund.js` → 트레이더 30개 SOL/USDP 분배 (+각 지갑 로그인 1회로 유저 row 생성)
6. 카테고리 목록 확보 → `config.categoryTargets` 확정
7. `run-creator.js` 1회 → 카테고리별 목표 수 생성 (openingRatios = PM odds)
8. `run-trader.js` + `run-odds-sync.js`(매시) 기동 → 24h 관찰 → Railway 배포
9. `resolve-check.js` 매일 — PM 해결 시 `quest.updateStatus` SUCCESS/REVOKE

**완료 기준**: 카테고리별 목표 수 충족 / 매시 oddsSync 후 `|p−p*| ≤ 0.03` / 30지갑 전부 거래 성공률 ≥ 95% / 니모닉으로 모든 지갑 복구 검증됨 / 레포에 비밀값 0.

---

# Part B — 플랫폼 레퍼런스 (검증된 사실)

## B1. 주소·토큰 (Solana mainnet; 비밀 아님)
```
API base            : https://solana-stg.polyquest.xyz   (tRPC: /api/trpc/<proc>, NextAuth: /api/auth/*)
어드민 페이지        : https://solana-stg.polyquest.xyz/admin
LS-LMSR 프로그램 ID  : 4tjbrvyzZ4PVuCnLKhrbbpcKd4ghnT6xxWPLQ2Mav68z   (programVersion 1)
USDP mint           : 9JFBge8qUEmnZ3XBhsvMNyfDJeNDojWL7s31oNFnGewN   (6 dec, 공급 600M, mintAuthority=JCGU, freeze=null)
  메타데이터         : name "Polyquest", symbol "USDP", 로고 설정됨 (Metaplex, mutable)
                      https://raw.githubusercontent.com/predictboi/token/main/usdp.json
BONK mint           : DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263   (5 dec)
USDC mint           : EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   (6 dec)
tokenId (quest.draft): USDP=4, BONK=6
PDA seeds           : market ['market', qid32LE] / vault ['vault', market] / position ['position', market, trader]
                      qid32LE = Buffer.alloc(32).writeBigUInt64LE(questId)
```
기존 지갑(참고): **684J** `684JgHdtUcm8y5N13XiZEvPkvdnh2pu75nfUEQtuvZDp` (테스트 마스터, USDP ~9.9M/BONK ~11.8M/SOL 0.18) · **JCGU** `JCGUheK5DFR7rFkpDJGdstpDpjCpccjSdCsRBCQmdTfX` (레지스트리 owner, USDP 민트권한, 메타데이터 updateAuthority) · **zJBEn…kv8Qk** (USDP 500M 보유). 두 키 모두 과거 채팅 노출 → 로테이션 권장. 새 봇은 이 키들을 **쓰지 않고** 니모닉 파생 지갑만 쓴다(펀딩만 이들에서 FUNDER로 송금).

## B2. LS-LMSR 수학 (`lslmsr.js`)
```
b(q) = alpha·Σq ;  C(q) = b·ln Σ exp(q_j/b)
p_i  = alpha·L + softmax_i − (alpha/b)·Σ q_j·softmax_j      (L = ln Σ exp(q_j/b))
buy k of i 비용 = C(q+k·e_i) − C(q) ;  sell 환불 = C(q) − C(q−k·e_i)
```
- 기본 `alpha 0.05`, 시드 15,000 USDP(cost-convention: `C(q0)=seed`). 비균등 개시확률은 2-outcome 이분탐색(`create-market.js` 참고).
- 메서드: `quoteBuy/quoteSell/sharesForAmount/buy/buyAmount/sell/prices/cost`. 순수 함수 → 오즈 싱크 금액 계산·교차검증에 사용.
- 온체인 q 읽기: `decodeAccount(market).outcome_shares_wad`(1e18) / `alpha_wad`(1e18).

## B3. 인증 (NextAuth v4 Credentials + Solana 서명; SIWS 아님) — `client.login(kp)`
1. `GET /api/auth/csrf` → csrfToken (+쿠키)
2. `POST /api/auth/nonce {walletAddress, chainType:'SOLANA'}` → `{nonce, message}`
3. `message`를 Ed25519 서명(Node crypto, PKCS8 prefix `302e020100300506032b657004220420` + 32B seed) → bs58
4. `POST /api/auth/callback/credentials {chainType, walletName:'automation', walletAddress, nonce, signature, csrfToken, json:'true'}` → `next-auth.session-token` 쿠키 → 쿠키 jar 유지
- 로그인만으로 **유저 row 생성**. 이메일: `setEmail`(session POST, `updateType:'WEB3_ADD_EMAIL'`).

## B4. tRPC 호출 규약
- POST `/api/trpc/<proc>` body `{ json: <input>, meta? }` (superjson). Date 필드는 `meta:{values:{endDate:['Date']}}`. 응답 `result.data.json`. 읽기 쿼리는 GET `?input=<urlencoded {json}>`.
- 에러 `error.json.data.code`: `NOT_FOUND`(프로시저 없음) / `BAD_REQUEST`(zod) / `INTERNAL_SERVER_ERROR`(핸들러).

**프로시저 (검증됨)**
| 프로시저 | 용도 / 입력 |
|---|---|
| `quest.draft` | 생성 1단계. `{type:'LSLMSR', title, description, relevantLink:null, creatorAddress, creatorFeePercent:0.02, endDate, tokenId:4, categoryId, imageUrl, minBetAmount:1, minRaiseAmount:1, programVersion:1, collateralKind:'pegged', answers:[{title}], seed:'15000', alpha:'0.05', openingRatios:['62','38']}` (+meta Date) → `{quest:{id,answers}, encodedTx}` |
| `quest.confirmDraftLslmsr` | `{questId, signedTx}` → 마켓 라이브(APPROVED). (`quest.approve`는 LSLMSR에 없음) |
| `quest.updateStatus` | 해결/종료. `{ id, data:{ status:'SUCCESS'\|'REVOKE', finalAnswerId } }` — 백엔드가 온체인 resolve 수행. enum: `DRAFT\|INVALID\|FUNDING\|FUNDED\|APPROVED\|FINISH\|SUCCESS\|REVOKE`, LSLMSR은 FINISH 불가. SUCCESS는 `finalAnswerId` 필수. |
| `quest.detail` | `questId` → `{answers:[{id,title,percent}], totalAmount, status, endDate…}` |
| `quest.listByWallet` | `{walletAddress, limit}` → 내가 만든 마켓 목록 |
| `quest.lslmsrPriceHistory` | `{questId, interval:'1h'\|'6h'\|'1d'\|'1w'\|'1m'\|'max'}` |
| `betting.draftLslmsr` | 거래 1단계. `{questId, answerId, solAmount:null, spent, source:'APP', kind:'BUY'\|'SELL', inputTokenAddr:<USDP mint>}` → `{betting:{id}, encodedTx}` |
| `betting.confirm` / `betting.confirmSell` | `{bettingId, signedTx}` (BUY/SELL) |
| `betting.listByWallet` | `{walletAddress, limit}` → `bettingTxn` 존재 = 온체인 랜딩 (confirm 거짓음성 재검증용) |
| `betting.listLslmsrPositionsByWallet` | `{walletAddress}` → 포지션 |

`signEncodedTx(kp, encodedTx)`: base64 → `VersionedTransaction.deserialize` 시도 → 실패 시 legacy `Transaction.from` → 서명 → base64.

## B5. 거래 유틸 (검증된 방어 로직)
- **confirm 거짓음성**: `betting.confirm`이 "Something went wrong"을 내도 실제 랜딩된 경우 많음 → `verifyBetLanded`(listByWallet에서 `bettingTxn` 폴링 4회) 후 성공 처리.
- **RPC stale read**: `confirmed`로 쓰고 바로 읽으면 옛값(QuickNode LB) → 검증 읽기는 `finalized`.
- **stall**: 모든 fetch/RPC await를 `withTimeout`(trade 45s, snap 20s, login 20s)로 감싸고 `unhandledRejection/uncaughtException` 로깅 후 생존.
- **우선수수료** 25,000 µLamports/CU, CU limit 300k~450k.
- decimals: USDP/USDC 6, BONK 5 → `BigInt(amount) * 10n**dec`.

## B6. 교훈 (하드-원)
1. 온체인만으로는 집계 안 됨 — 백엔드 draft/confirm 필수.
2. Polyquest confirm 거짓음성 → read-back 재검증.
3. RPC read-after-write 지연 → finalized 재조회.
4. 네트워크 await 영구 행 → withTimeout.
5. superjson 래핑 + Date meta.
6. 컨테이너 휘발 — git-ignored 파일·백그라운드 프로세스 전부 소멸 → 비밀은 Environment Secrets, 런타임은 Railway.
7. USDP 민트권한 살아있음(JCGU) — 공급 고정 원하면 revoke(비가역).
8. Ed25519 서명은 Node crypto로 충분.
9. decimals 주의.
10. 서브월렛 키 백업 필수 — 2026-10 `subwallets.json` 분실로 볼트 lock분(42k USDP + 3.9M BONK) 영구 회수 불가. → **니모닉 파생 체계(§A2)로 근본 해결.**
11. **마켓 종료는 반드시 백엔드 `quest.updateStatus`로** — 핸들러가 플랫폼 키로 온체인 resolve를 보낸다(ix index 2). JCGU로 온체인 `resolveIx`를 먼저 날리면 백엔드 resolve가 `custom error 0x0`(AlreadyResolved)로 실패 → `updateStatus` 영구 500 → DB 수정 없이는 프론트 status 변경 불가. (q900028/900030/900031에서 실제 발생, 백엔드 status APPROVED로 남음.)
12. LSLMSR에 FINISH 없음 — APPROVED → SUCCESS/REVOKE 직접.
13. admin만으론 볼트 전액 회수 불가 — `sweepResidual`은 `vault − 승리 outcome share 공급량`(진짜 residual)만 허용(초과 시 `0xa`), closeMarket은 포지션 열려 있으면 `0x2a`. 유저 플로우를 지키면 애초에 필요 없는 지식.
14. 테스트 중 "유저 플로우 vs 온체인 직접"을 섞지 말 것 — 섞는 순간 복구 불능 상태가 생긴다(원칙 1).

## B7. (참고, 범위 밖) forecast.vote / KAIA
`tools/lslmsr-test/`에 KAIA 허브(`0x44AD1e2929A4bB0c0692AF1E54D7B19C2a0C9A24`, USDF `0x08a72F6c…cb3`, chainId 8217) 용 동일 구조 툴킷 존재(`create-market.js`, `soak.js`: createBet→온체인→confirmBet bracketing). 이번 빌드는 Polyquest 전용.

## B8. 기존 파일 맵 (이식 대상 표시)
```
tools/solana-lslmsr-test/polyquest.mjs   ★이식: 유저 플로우 클라이언트 (login/signup/createMarket/trade/verifyBetLanded/read)
tools/lslmsr-test/src/lslmsr.js          ★이식: LS-LMSR 수학
tools/lslmsr-test/src/gen-image.js       ★이식: Gemini 썸네일 (프리셋 market/asset/person/event)
tools/solana-lslmsr-test/src/client.js   ★이식(읽기 전용): decodeAccount, marketPda, questionId
tools/solana-lslmsr-test/soak24.mjs      참고: 볼륨 트레이더 전략(밴드·플럭스·라운드로빈)
tools/solana-lslmsr-test/create-3.mjs    참고: createMarket 호출 예
tools/solana-lslmsr-test/mainnet-lib.mjs / close-max.mjs / settle-all.mjs / close-market.mjs
                                         ✖ 새 봇에서 사용 금지 (온체인 직접 쓰기 = 원칙 1 위반). 비상 복구 전용.
```

## B9. ENV 템플릿 (`.env.example` — 값 없이 커밋)
```
# ===== 비밀 (Environment Secrets / Railway Variables / git-ignored .env 에만) =====
MNEMONIC=<12 or 24 words>
RPC_URL=<QuickNode Solana mainnet URL (API key 포함)>
GEMINI_API_KEY=<optional, thumbnails>

# ===== 공개 =====
POLYQUEST_API_BASE=https://solana-stg.polyquest.xyz
LSLMSR_PROGRAM_ID=4tjbrvyzZ4PVuCnLKhrbbpcKd4ghnT6xxWPLQ2Mav68z
USDP_MINT=9JFBge8qUEmnZ3XBhsvMNyfDJeNDojWL7s31oNFnGewN
COLLATERAL_DECIMALS=6
TRADER_COUNT=30
MARKET_SEED_USDP=15000
MARKET_ALPHA=0.05
ODDS_SYNC_CRON=7 * * * *
ODDS_BAND=0.02
MAX_MOVE_PER_SYNC=0.08
SOL_MIN=0.05
SOL_TOPUP=0.1
USDP_MIN=500
```
