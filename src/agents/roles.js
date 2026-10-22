// One Agent per role. Each wraps the corresponding module and returns a compact report for the dashboard.
import { Agent } from './base.js';
import { getSettings } from '../state.js';
import * as funding from '../funding.js';
import * as creator from '../creator.js';
import { VolumeTrader } from '../trader.js';
import { syncAll } from '../oddsSync.js';
import { checkAll } from '../resolver.js';
import { buildSnapshot } from '../reporting.js';
import { hasMnemonic } from '../wallets.js';

const S = () => getSettings();
const on = (k) => () => !!S().agents[k];

export function buildAgents() {
  const trader = new VolumeTrader();
  const agents = {
    funding: new Agent({ name: 'funding', title: '펀딩 에이전트', description: 'FUNDER → 지갑 SOL/USDP 잔액 점검·자동 보충 (30분마다)', cron: () => S().funding.cron, enabled: on('funding'),
      run: async ({ params }) => { if (!hasMnemonic()) throw new Error('MNEMONIC not set'); if (params?.mode === 'initial') return funding.distributeInitial(); if (params?.mode === 'sweep') return funding.sweep(params); if (params?.mode === 'refresh') return { balances: await funding.refreshBalances() }; return funding.topUp(); },
      summarize: (r) => r.balances ? { refreshed: r.balances.length } : { transfers: r.plan?.transfers?.length ?? (r.done?.length ?? 0), done: r.done?.length ?? 0, failed: r.failed?.length ?? 0, skipped: r.skipped || null, shortSol: r.plan?.shortSol ?? 0, shortUsdp: r.plan?.shortUsdp ?? 0 } }),
    creator: new Agent({ name: 'creator', title: '크리에이터 에이전트', description: '카테고리별 목표 수만큼 Polymarket 기반 마켓 생성 (6시간마다, 유저 플로우)', cron: () => S().creator.cron, enabled: on('creator'),
      run: async ({ params }) => { if (!hasMnemonic()) throw new Error('MNEMONIC not set'); if (params?.mode === 'sync') return { sync: await creator.syncFromPlatform(), shortfall: creator.shortfall() }; return creator.replenish({ maxCreate: params?.maxCreate }); },
      summarize: (r) => ({ created: r.created?.length ?? 0, failed: r.failed?.length ?? 0, skipped: r.skipped || null, roles: r.creators ? Object.fromEntries(Object.entries(r.creators).map(([k, c]) => [k, c.role || null])) : null, sync: r.sync, need: Object.values(r.shortfall || {}).reduce((a, x) => a + x.need, 0) }) }),
    trader: new Agent({ name: 'trader', title: '트레이딩 에이전트', description: '30개 지갑 라운드로빈 볼륨 거래 (상시 루프, p* ± 밴드 유지)', loop: true, enabled: on('trader'),
      run: async ({ shouldStop }) => { if (!hasMnemonic()) throw new Error('MNEMONIC not set'); await trader.run({ shouldStop }); return trader.stats; } }),
    oddsSync: new Agent({ name: 'oddsSync', title: '오즈 싱크 에이전트', description: '매시 Polymarket odds와 LS-LMSR 가격 비교 → 트레이더 지갑으로 보정 매수', cron: () => S().oddsSync.cron, enabled: on('oddsSync'),
      run: async () => { if (!hasMnemonic()) throw new Error('MNEMONIC not set'); return syncAll(); },
      summarize: (r) => ({ markets: r.markets, inBand: r.inBand, moved: r.moved, spent: r.spent, errors: r.errors }) }),
    resolver: new Agent({ name: 'resolver', title: '해결 에이전트', description: 'Polymarket 해결 결과 → quest.updateStatus SUCCESS/REVOKE (매일, 크리에이터 플로우)', cron: () => S().resolver.cron, enabled: on('resolver'),
      run: async () => { if (!hasMnemonic()) throw new Error('MNEMONIC not set'); return checkAll(); },
      summarize: (r) => ({ checked: r.checked, resolved: r.resolved?.length ?? 0, pending: r.pending?.length ?? 0, manual: r.manual?.length ?? 0, errors: r.errors?.length ?? 0 }) }),
    reporter: new Agent({ name: 'reporter', title: '리포터 에이전트', description: '매시 스냅샷(마켓/볼륨/성공률/잔액) + 일간 리포트 작성', cron: () => S().reporter.cron, enabled: on('reporter'),
      run: async () => buildSnapshot(), summarize: (r) => ({ markets: r.markets, trades24h: r.trades24h, successRate: r.successRate, volume24h: r.volume24h, inBandPct: r.inBandPct }) }),
  };
  agents.trader.traderRef = trader;
  return agents;
}
