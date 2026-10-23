// Central configuration. Secrets come only from the environment (never from files in the repo).
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

// DATA_ROOT: where mutable state/reports/thumbnails live. Point it at a persistent disk in production (Render disk, Railway volume).
const DATA_ROOT = env('DATA_ROOT', ROOT);
export const PATHS = {
  root: ROOT,
  state: path.join(DATA_ROOT, 'state'),
  reports: path.join(DATA_ROOT, 'reports'),
  data: path.join(DATA_ROOT, 'data'),
  thumbs: path.join(DATA_ROOT, 'data', 'thumbs'),
  topics: path.join(ROOT, 'topics'),
  public: path.join(ROOT, 'src', 'dashboard', 'public'),
};

// Polyquest categories (verified via category.listAll on solana-stg) and the Polymarket tag slugs used to source topics.
export const CATEGORIES = [
  { id: 1, name: 'Politics', ko: '정치', tags: ['politics', 'elections', 'geopolitics'] },
  { id: 2, name: 'Sports', ko: '스포츠', tags: ['sports', 'esports'],
    // picked round-robin in this order (international soccer first and twice per cycle); club soccer only from top-flight tags
    buckets: [
      { key: 'soccer-intl', tags: ['uefa-nations-league', 'intlpt-soccer', 'international-friendlies', 'world-cup-qualifiers', 'fifa-world-cup-qualifiers'] },
      { key: 'nfl', tags: ['nfl'] },
      { key: 'soccer-intl', tags: ['uefa-nations-league', 'intlpt-soccer', 'international-friendlies', 'world-cup-qualifiers', 'fifa-world-cup-qualifiers'] },
      { key: 'mlb', tags: ['mlb', 'world-series'] },
      { key: 'soccer-top', tags: ['EPL', 'la-liga', 'bundesliga', 'serie-a', 'ligue-1', 'champions-league'] },
      { key: 'nba', tags: ['nba'] },
      { key: 'other', tags: ['nhl', 'ufc', 'f1'] },
    ],
    exclude: /exact score|any other score|o\/u|over\/under|assists|rebounds|points o|completed match|halftime|corners|cards/i,
    priceBand: [0.1, 0.9] }, // skip long shots / near-certain picks
  { id: 3, name: 'Crypto', ko: '크립토', tags: ['crypto'] },
  { id: 4, name: 'Economics', ko: '경제', tags: ['economy', 'business', 'finance', 'economics'] },
  { id: 5, name: 'Culture', ko: '문화', tags: ['pop-culture', 'music', 'movies'] },
  { id: 6, name: 'Science', ko: '과학', tags: ['science', 'space', 'climate'] },
  { id: 7, name: 'Social', ko: '사회', tags: ['world', 'health', 'climate'] },
  { id: 8, name: 'Other', ko: '기타', tags: ['tech', 'ai', 'world'] },
];
export const categoryById = (id) => CATEGORIES.find((c) => c.id === Number(id));
export const categoryByName = (name) => CATEGORIES.find((c) => c.name.toLowerCase() === String(name).toLowerCase());

// Defaults; anything under `settings` can be overridden at runtime from the dashboard (state/settings.json).
export const DEFAULT_SETTINGS = {
  categoryTargets: { Politics: 10, Sports: 15, Crypto: 12, Economics: 12, Culture: 8, Science: 7, Social: 8, Other: 8 }, // 80 markets
  agents: { funding: true, creator: true, trader: true, oddsSync: true, resolver: true, reporter: true },
  creator: { cron: '0 */6 * * *', endDateMinDays: 3, endDateMaxDays: 90, maxCreatePerRun: 12, pauseMs: 4000,
    // which creator wallet owns (creates + resolves) each category; unlisted categories go to CREATOR
    assign: { CREATOR: ['Politics', 'Economics', 'Crypto', 'Science'], 'CREATOR-02': ['Sports', 'Culture', 'Social', 'Other'] },
    // seed (USDP) per new market, drawn uniformly from [min, max] and rounded to 100; markets made before this use 15,000
    seedRange: [40000, 70000] },
  // organic trader (src/organic.js): ~tradesPerDay Poisson arrivals shaped by the UTC hour curve, persona wallets on favorite markets
  trader: { tradesPerDay: num('TRADES_PER_DAY', 800), weekendFactor: 0.8, burstP: 0.06, coverP: 0.25, band: 0.05, sellP: 0.3, minHoldMin: 120, followMove: 0.03, maxBuyFrac: 0.15, snapMin: 10, minGapMs: 4000 },
  oddsSync: { cron: env('ODDS_SYNC_CRON', '7 * * * *'), band: num('ODDS_BAND', 0.02), maxMove: num('MAX_MOVE_PER_SYNC', 0.08), maxSpend: num('ODDS_MAX_SPEND', 3000), walletsMin: 2, walletsMax: 4, pauseMs: 2000, chunkJitterMs: 60000, spreadMin: 40 },
  funding: { cron: '*/30 * * * *', solMin: num('SOL_MIN', 0.03), solTopup: num('SOL_TOPUP', 0.04), usdpMin: num('USDP_MIN', 500), usdpTopup: num('USDP_TOPUP', 5000), traderSolInit: 0.08, traderUsdpInit: 50000, creatorSolInit: 0.3, creatorUsdpInit: 900000, funderSolReserve: 0.2 },
  resolver: { cron: '30 0 * * *' },
  reporter: { cron: '3 * * * *' },
};

export const CONFIG = {
  apiBase: env('POLYQUEST_API_BASE', 'https://solana-stg.polyquest.xyz').replace(/\/$/, ''),
  rpcUrl: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  rpcIsFallback: !env('RPC_URL'),
  programId: env('LSLMSR_PROGRAM_ID', '4tjbrvyzZ4PVuCnLKhrbbpcKd4ghnT6xxWPLQ2Mav68z'),
  usdpMint: env('USDP_MINT', '9JFBge8qUEmnZ3XBhsvMNyfDJeNDojWL7s31oNFnGewN'),
  usdpTokenId: 4,
  collateralDecimals: num('COLLATERAL_DECIMALS', 6),
  traderCount: num('TRADER_COUNT', 30),
  market: { seed: env('MARKET_SEED_USDP', '15000'), alpha: env('MARKET_ALPHA', '0.05'), creatorFeePercent: 0.02, minBetAmount: 1, minRaiseAmount: 1, programVersion: 1, collateralKind: 'pegged' },
  dashboard: { port: num('PORT', 8787), token: env('DASHBOARD_TOKEN', ''), publicBaseUrl: env('PUBLIC_BASE_URL', '').replace(/\/$/, '') },
  gemini: { apiKey: env('GEMINI_API_KEY', ''), model: env('GEMINI_IMAGE_MODEL', 'gemini-2.5-flash-image') },
  anthropic: { apiKey: env('ANTHROPIC_API_KEY', ''), model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5') },
  adminSecretKey: env('ADMIN_SECRET_KEY', ''),
  masterSecretKey: env('MASTER_SECRET_KEY', ''),
  dryRun: env('DRY_RUN', '0') === '1',
  timeouts: { login: 20000, trade: 45000, read: 20000, rpc: 20000 },
  priorityFeeMicroLamports: 25000,
  computeUnits: 300000,
  polymarket: { gamma: 'https://gamma-api.polymarket.com', clob: 'https://clob.polymarket.com' },
};
