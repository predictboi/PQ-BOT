# Polyquest 운영 봇 (Solana 스테이징)

크리에이터 봇 · 트레이딩 봇(지갑 30개) · Polymarket 오즈 싱크 · 해결 · 펀딩 · 리포팅을 **역할별 에이전트**로 돌리고, 하나의 **대시보드**에서 보고 제어한다.  
대상: https://solana-stg.polyquest.xyz · 설계 원문: [`docs/HANDOFF.md`](docs/HANDOFF.md) · 이 저장소는 봇 전용이며 프로덕트와 완전히 분리되어 있다.

## 원칙 (절대 위반 금지)
1. **모든 플랫폼 동작은 유저 플로우로만** — 지갑 로그인 → 프론트가 호출하는 tRPC를 그대로(`quest.draft → confirmDraftLslmsr`, `betting.draftLslmsr → confirm/confirmSell`, `quest.updateStatus`) → 서버가 준 tx를 지갑으로 서명. 온체인 ix 직접 전송·DB 직접 수정 금지. 온체인은 **읽기**(잔액, 마켓 계정 디코드)와 **일반 송금**(펀딩/회수)만.
2. **키는 니모닉 1개에서 전부 파생** (`m/44'/501'/{i}'/0'`, Phantom 호환). index 0 FUNDER · 1 CREATOR · 2~31 TRADER-01~30. 개인키 파일은 만들지 않는다.

## 구성
```
(repo root)
  bin/            CLI 진입점 (run · init-wallets · fund · status · run-creator · run-trader · run-odds-sync · resolve-check · sweep · login-all)
  src/
    config.js     설정/카테고리(Polymarket 태그 매핑)/기본 파라미터
    wallets.js    니모닉 → 지갑 파생          client/polyquest.js  유저 플로우 클라이언트 + 세션 풀
    lslmsr.js     LS-LMSR 수학 (정규화 가격 = 사이트 표기)   chain/read.js · chain/transfer.js  온체인 읽기 / 일반 송금
    polymarket.js Gamma/CLOB 읽기             research.js  카테고리별 토픽 → 마켓 스펙 (Claude 작성 선택)
    images.js     썸네일 (Gemini 선택 / 로컬 타일)         funding.js  분배·탑업·회수
    creator.js    카테고리 목표 수 유지·생성   trader.js  30지갑 볼륨 루프   oddsSync.js  매시 PM odds 보정   resolver.js  해결
    agents/       base(Agent) · roles(역할별 6개) · supervisor(체크리스트·스냅샷)
    dashboard/    server.js (JSON API · SSE · 제어) + public/index.html (Polyquest 디자인)
    reporting.js  시간별 스냅샷 · 일간 리포트 · 거래 통계
  state/addresses.json  주소표 (커밋 OK)   state/markets.json  questId ↔ Polymarket 매핑 (커밋 OK)
  reports/ data/        런타임 산출물 (git-ignored)
```

### 에이전트
| 에이전트 | 스케줄(UTC) | 하는 일 |
|---|---|---|
| funding | 30분마다 | 전 지갑 SOL/USDP 조회 → 최소치 미만 지갑에 FUNDER가 탑업. 대시보드에서 초기 분배/회수 |
| creator | 6시간마다 | 플랫폼 동기화 → 카테고리별 `목표 − 라이브` 만큼 Polymarket 상위 마켓을 골라 생성 (openingRatios = 생성 시점 PM odds, relevantLink = PM URL) |
| trader | 상시 루프 | 30지갑 라운드로빈, 마켓당 시간당 N회, p* ± 밴드 안에서 양방향 매매 (밴드 밖이면 p* 쪽으로) |
| oddsSync | 매시 :07 | `quest.lslmsrState` q/alpha → 로컬 LS-LMSR 모델로 정규화 가격 p, Polymarket midpoint p*. 밴드 밖이면 이분탐색으로 필요 금액 산출(1회 최대 이동·금액 상한) → 트레이더 2~4지갑으로 매수 |
| resolver | 매일 00:30 | Polymarket 해결 → `quest.updateStatus SUCCESS(finalAnswerId)`, 무효 → `REVOKE`. 매핑 없는 마켓은 대시보드에서 수동 해결 |
| reporter | 매시 :03 | 스냅샷(라이브 수·인밴드%·24h 거래/볼륨/성공률·잔액) + `reports/daily/YYYY-MM-DD.md` |

## Day-0 체크리스트 (대시보드 개요 탭에 실시간 표시)
1. `npm run gen-mnemonic -- --out <안전한 경로>` → 24단어를 패스워드 매니저 + **Environment Secrets / Railway Variables**에 `MNEMONIC` 으로 등록 (이미 생성·전달됨: `state/addresses.json` 참고)
2. `npm run init-wallets` → `state/addresses.json` (주소만) 커밋. Phantom에 니모닉 import → 계정 1~3 = index 0~2 주소 일치 확인. **일치 전 펀딩 금지**
3. FUNDER(index 0)에 **≈12 SOL + ≈2.5M USDP** 입금 (또는 `MASTER_SECRET_KEY` 설정 후 `node bin/fund.js --from-master --sol 12 --usdp 2500000`)
4. `node bin/login-all.js` (이미 1회 수행 → 유저 row 생성됨) → 사람이 마스터 지갑으로 `/admin` 접속, **CREATOR 주소를 Creator로 승격** → 체크리스트 "CREATOR 승격" ✓
5. 대시보드 지갑 탭 **초기 분배** (또는 `node bin/fund.js --initial`)
6. 설정 탭에서 카테고리 목표 확인 (기본: Politics/Sports/Crypto/Economics 10, 그 외 5)
7. 크리에이터 **지금 실행** → 생성 확인 → 트레이더 **시작**, 오즈 싱크는 매시 자동 (수동 실행 가능)
8. 24h 관찰 후 Railway 배포

## 실행
```bash
npm install
cp .env.example .env   # 값 채우기 (MNEMONIC, RPC_URL, DASHBOARD_TOKEN …)
npm start              # 슈퍼바이저(전 에이전트) + 대시보드 http://localhost:8787
npm run dashboard      # 에이전트 없이 대시보드만
npm run status         # 터미널 상태 요약
npm test               # 단위 테스트 (LS-LMSR · 지갑 파생 · Polymarket 파싱 · 오즈 싱크 계획)
DRY_RUN=1 npm start    # 서명/전송 없이 계획만 로그
```
개별 실행: `node bin/run-creator.js [--max N|--sync|--status]`, `node bin/run-trader.js --minutes 30`, `node bin/run-odds-sync.js`, `node bin/resolve-check.js [--resolve <questId> YES|NO|REVOKE]`, `node bin/fund.js --plan|--initial [--traders N --creator-sol X --trader-sol X --creator-usdp X --trader-usdp X]|--topup|--balances|--sweep|--from-master|--from-admin --sol X --usdp Y` (`--traders 2` 처럼 일부 지갑만 먼저 분배 가능).

## 대시보드
- **개요**: Day-0 체크리스트, KPI(라이브/목표 · 24h 거래/성공률 · 볼륨 · 인밴드 · 트레저리), 카테고리 진행, 에이전트 카드(지금 실행/일시정지), 실시간 로그
- **에이전트**: 상태·다음 실행·마지막 결과·실행 이력
- **마켓**: p(우리) vs p*(Polymarket) 바·Δ 칩, 24h 볼륨, D-day, 상태, Polyquest/Polymarket 링크, **해결(YES/NO/REVOKE)**, 테스트 거래
- **지갑**: 32개 잔액·24h 거래/실패, 잔액 새로고침 · 초기 분배 · 탑업 · 회수
- **리포트**: 시간별 차트(인밴드% · 24h 볼륨 · 성공률 · USDP 합계), 일간 리포트, 오즈 싱크 기록
- **설정**: 카테고리 목표, 에이전트 on/off, 트레이더/오즈 싱크/펀딩 파라미터, cron — 저장 즉시 반영
- 인증: `DASHBOARD_TOKEN` (쿠키 로그인 / `Authorization: Bearer` / `?token=`). 썸네일은 `/thumbs/*` 공개.

## Railway
한 번에 프로비저닝: `RAILWAY_TOKEN`(계정/팀 토큰) + 봇 변수들을 환경에 둔 상태에서 `node bin/railway-setup.js --project bots --service polyquest-bot` → 프로젝트 `bots` 생성, GitHub 서비스 연결(이 저장소), 변수 복사, 공개 도메인 생성(`PUBLIC_BASE_URL` 자동), 배포. `--check`는 토큰 확인과 프로젝트 목록만.  
`railway.json` + `nixpacks.toml` 포함. 서비스 Variables에 `MNEMONIC`, `RPC_URL`, `DASHBOARD_TOKEN`, `PUBLIC_BASE_URL`(서비스 공개 URL), 선택 `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` 등록 → `npm start`. 헬스체크 `/health`.  
`state/`·`reports/`는 컨테이너 디스크에 쓰이므로 영구 볼륨을 마운트하고 `DATA_ROOT`로 가리키면 재배포 후에도 markets.json/리포트가 유지된다(없어도 markets.json은 크리에이터 동기화로 플랫폼에서 복구됨).

## Render (render.com)
루트 `render.yaml`에 `polyquest-bot` Web Service가 정의돼 있다 (Blueprint → 이 저장소 → 동기화하면 생성; 수동 생성 시 Root Directory 비움, Build `npm ci --omit=dev`, Start `npm start`, Health `/health`). 또는 `RENDER_API_KEY`를 환경에 두고 `node bin/render-setup.js` 로 API 생성/변수 갱신.
- **플랜은 starter 이상** — free 플랜은 트래픽 없으면 중지되어 봇이 멈춘다.
- 디스크 `/var/data`를 `DATA_ROOT`로 써서 `state/markets.json`·리포트·썸네일이 재배포 후에도 유지된다 (없어도 markets.json은 플랫폼 동기화로 복구).
- 비밀값(`MNEMONIC`, `RPC_URL`, `DASHBOARD_TOKEN`, 선택 키)은 Render 대시보드 Environment에서 입력. 대시보드 주소는 `https://<서비스명>.onrender.com`.

## 키 보관 원칙
- **Railway(상시 서버)에는 봇 운영에 필요한 것만**: `MNEMONIC`, `RPC_URL`, `DASHBOARD_TOKEN`, `PUBLIC_BASE_URL`, 선택 `GEMINI_API_KEY`/`ANTHROPIC_API_KEY`.
- **마스터 키·어드민 키·`RAILWAY_TOKEN`은 Railway에 두지 않는다.** 1회 작업(FUNDER 입금, 크리에이터 승격, 프로비저닝)에만 클라우드 세션 환경에서 쓰고 끝나면 제거. `railway-setup.js`도 기본적으로 복사하지 않는다(`--with-admin-keys`로만 허용). 대시보드 체크리스트가 서버에 고권한 키가 남아 있으면 경고한다.
- 니모닉이 유출되면 즉시 `bin/sweep.js`로 FUNDER 회수 → 새 니모닉 생성·교체.

## 선택 키
| 키 | 용도 |
|---|---|
| `GEMINI_API_KEY` | 마켓 썸네일 생성 — Polymarket/Kalshi 스타일(히어로 주제 1개, 텍스트·숫자·로고 금지, 풀블리드 1:1, 512×512 JPG). 주제는 Claude 작성값 → 질문 키워드 규칙(`subjectFor`) → 카테고리 기본값 순. 없으면 로컬 추상 타일(텍스트 없음) |
| `ANTHROPIC_API_KEY` | 마켓 제목/설명 한국어 작성 (없으면 원문 질문 + 한국어 템플릿) |
| `ADMIN_SECRET_KEY` | 해결 시 크리에이터 권한이 거부될 때만 어드민 세션으로 폴백 |
| `MASTER_SECRET_KEY` | `fund.js --from-master` 로 FUNDER 입금할 때만 (`ADMIN_SECRET_KEY`는 `--from-admin`으로 동일하게 입금 가능) |
