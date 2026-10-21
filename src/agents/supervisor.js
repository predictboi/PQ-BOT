// Supervisor: owns the agents, exposes a snapshot + setup checklist for the dashboard, streams changes.
import { EventEmitter } from 'node:events';
import { CONFIG, PATHS, CATEGORIES } from '../config.js';
import { buildAgents } from './roles.js';
import { hasMnemonic, deriveAddresses } from '../wallets.js';
import { rpcHealth } from '../chain/read.js';
import * as pq from '../client/polyquest.js';
import * as funding from '../funding.js';
import * as creator from '../creator.js';
import { getSettings, loadRuntime, loadAddresses, allMarkets } from '../state.js';
import { createLogger, logEvents, nowIso, round } from '../util.js';
import { tradeStats, marketSummary } from '../reporting.js';

const log = createLogger('supervisor');

export class Supervisor extends EventEmitter {
  constructor() { super(); this.agents = buildAgents(); this.startedAt = null; this.setup = null; for (const a of Object.values(this.agents)) a.on('change', (s) => this.emit('agent', s)); logEvents.on('log', (rec) => this.emit('log', rec)); }

  async start({ only } = {}) {
    this.startedAt = nowIso();
    await this.refreshSetup().catch((e) => log.warn('setup check failed:', e.message));
    if (hasMnemonic()) { try { await creator.syncFromPlatform(); } catch (e) { log.warn('initial sync failed:', e.message.slice(0, 120)); } }
    for (const [name, a] of Object.entries(this.agents)) { if (only && !only.includes(name)) continue; a.start(); }
    log.info(`started agents: ${Object.values(this.agents).filter((a) => a.enabled).map((a) => a.name).join(', ')}`);
    this.setupTimer = setInterval(() => this.refreshSetup().catch(() => {}), 10 * 60000);
  }
  stop() { clearInterval(this.setupTimer); for (const a of Object.values(this.agents)) a.stop(); }
  agent(name) { const a = this.agents[name]; if (!a) throw new Error(`unknown agent ${name}`); return a; }

  /** Day-0 checklist, evaluated live. */
  async refreshSetup() {
    const s = getSettings(); const f = s.funding; const items = [];
    const mn = hasMnemonic(); items.push({ key: 'mnemonic', label: 'MNEMONIC 설정 (Environment Secrets / Railway)', ok: mn, detail: mn ? '설정됨' : 'MNEMONIC 없음 — npm run gen-mnemonic 으로 생성 후 Secrets에 등록' });
    const addr = loadAddresses(); let addrOk = addr.wallets?.length > 0; let addrDetail = addrOk ? `${addr.wallets.length}개 주소 (state/addresses.json)` : 'state/addresses.json 없음 — npm run init-wallets';
    if (mn && addrOk) { const d = deriveAddresses(); const mismatch = d.some((w, i) => addr.wallets[i]?.address !== w.address); if (mismatch) { addrOk = false; addrDetail = 'addresses.json이 현재 MNEMONIC과 불일치 — npm run init-wallets 재실행'; } }
    items.push({ key: 'addresses', label: '지갑 주소 파생·커밋 (FUNDER/CREATOR/TRADER×30)', ok: addrOk, detail: addrDetail });
    const rpc = await rpcHealth(); items.push({ key: 'rpc', label: 'Solana RPC', ok: rpc.ok && !CONFIG.rpcIsFallback, warn: rpc.ok && CONFIG.rpcIsFallback, detail: rpc.ok ? (CONFIG.rpcIsFallback ? `public RPC 폴백 사용 중 (slot ${rpc.slot}) — RPC_URL(QuickNode) 등록 권장` : `연결됨 (slot ${rpc.slot})`) : `연결 실패: ${rpc.error}` });
    let api = { ok: false }; try { const c = await pq.categories(); api = { ok: true, n: (c?.data || c || []).length }; } catch (e) { api = { ok: false, error: e.message }; }
    items.push({ key: 'api', label: `Polyquest API (${CONFIG.apiBase})`, ok: api.ok, detail: api.ok ? `연결됨 · 카테고리 ${api.n}개` : `실패: ${api.error}` });
    const rt = loadRuntime(); const funder = rt.balances?.find((b) => b.index === 0);
    const needSol = round(f.creatorSolInit + f.traderSolInit * CONFIG.traderCount + f.funderSolReserve, 2), needUsdp = round(f.creatorUsdpInit + f.traderUsdpInit * CONFIG.traderCount, 0);
    const funded = funder && funder.sol >= needSol * 0.5 && funder.usdp >= needUsdp * 0.5;
    items.push({ key: 'funder', label: 'FUNDER 입금 (SOL + USDP)', ok: !!funded, warn: !!funder && !funded && (funder.sol > 0 || funder.usdp > 0), detail: funder ? `현재 ${funder.sol} SOL / ${funder.usdp} USDP · 권장 ${needSol} SOL / ${needUsdp.toLocaleString()} USDP · 주소 ${funder.address}` : (mn ? '잔액 미조회 — 펀딩 에이전트 실행' : 'MNEMONIC 필요') });
    let cr = null; if (mn && api.ok) { try { cr = await creator.creatorStatus(); } catch (e) { cr = { error: e.message }; } }
    items.push({ key: 'creator', label: 'CREATOR 승격 (/admin → User → Creator)', ok: !!cr?.promoted, detail: cr ? (cr.error ? `확인 실패: ${cr.error}` : `${cr.address} · role ${cr.role}${cr.promoted ? '' : ' — 마스터 지갑으로 /admin 에서 승격 필요'}`) : 'MNEMONIC/API 필요' });
    const traders = (rt.balances || []).filter((b) => b.role === 'TRADER'); const readyT = traders.filter((b) => b.usdp >= f.usdpMin && b.sol >= f.solMin).length;
    items.push({ key: 'traders', label: '트레이더 30개 분배', ok: traders.length > 0 && readyT === traders.length, warn: readyT > 0 && readyT < traders.length, detail: traders.length ? `${readyT}/${traders.length} 지갑 준비됨 (USDP ≥ ${f.usdpMin}, SOL ≥ ${f.solMin})` : '잔액 미조회' });
    const ms = marketSummary(); const target = Object.values(ms.byCat).reduce((a, x) => a + x.target, 0);
    items.push({ key: 'markets', label: '카테고리별 마켓 목표', ok: ms.live >= target && target > 0, warn: ms.live > 0 && ms.live < target, detail: `라이브 ${ms.live} / 목표 ${target}` });
    items.push({ key: 'dashboardToken', label: '대시보드 토큰 (DASHBOARD_TOKEN)', ok: !!CONFIG.dashboard.token, detail: CONFIG.dashboard.token ? '설정됨' : '미설정 — 공개 배포 전 반드시 설정' });
    items.push({ key: 'publicUrl', label: '썸네일 공개 URL (PUBLIC_BASE_URL)', ok: !!CONFIG.dashboard.publicBaseUrl, warn: !CONFIG.dashboard.publicBaseUrl, detail: CONFIG.dashboard.publicBaseUrl || '미설정 — 생성 마켓에 플레이스홀더 썸네일 사용' });
    const privileged = [CONFIG.masterSecretKey && 'MASTER_SECRET_KEY', CONFIG.adminSecretKey && 'ADMIN_SECRET_KEY'].filter(Boolean);
    items.push({ key: 'privilegedKeys', label: '고권한 키 분리 (마스터/어드민 키는 상시 서버에 두지 않기)', ok: privileged.length === 0, warn: privileged.length > 0, detail: privileged.length ? `${privileged.join(', ')} 가 이 프로세스 환경에 있음 — 1회 작업(입금·승격) 후 제거 권장` : '서버에 없음 (봇 운영엔 MNEMONIC만 필요)' });
    this.setup = { at: nowIso(), items, done: items.filter((i) => i.ok).length, total: items.length, creator: cr, rpc, api };
    this.emit('setup', this.setup); return this.setup;
  }

  snapshot() {
    const rt = loadRuntime();
    return {
      startedAt: this.startedAt, now: nowIso(), dryRun: CONFIG.dryRun, apiBase: CONFIG.apiBase, version: '0.1.0',
      agents: Object.values(this.agents).map((a) => a.snapshot()),
      setup: this.setup, settings: getSettings(), categories: CATEGORIES,
      markets: marketSummary(), trades: (({ n, ok, fail, successRate, volume }) => ({ n, ok, fail, successRate, volume }))(tradeStats(24)),
      totals: rt.totals || null, balancesAt: rt.balancesAt || null, lastOddsSync: rt.lastOddsSync || null,
      traderStats: this.agents.trader.traderRef?.stats || null, skippedWallets: [...(this.agents.trader.traderRef?.skippedWallets || [])],
    };
  }
}
