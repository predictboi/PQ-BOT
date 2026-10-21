// Market thumbnails. Polyquest `quest.draft` takes a public imageUrl and re-hosts it under /api/images/quest/<uuid>.
//   1) Gemini (GEMINI_API_KEY) → 512x512 JPG, Kalshi/Polymarket-style, no text   (ported from tools/lslmsr-test/src/gen-image.js)
//   2) fallback: locally rendered abstract gradient tile (sharp), no text
// Files are saved to data/thumbs/<key>.jpg and served by the dashboard at /thumbs/<key>.jpg (PUBLIC_BASE_URL).
// Without PUBLIC_BASE_URL we fall back to a neutral placeholder URL so creation never blocks.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG, PATHS, categoryById } from './config.js';
import { ensureDir, withTimeout, createLogger } from './util.js';

const log = createLogger('images');
const PLACEHOLDER = 'https://placehold.co/512x512/1b1c1f/7ce85c/png?text=+';
const MARKET_STYLE = (subject) =>
  'Premium prediction-market card thumbnail in the visual style of Kalshi and Polymarket market cards. ' +
  `A SINGLE bold, instantly recognizable hero subject centered and filling the frame: ${subject || 'the central icon or figure of the market topic'}. ` +
  'Clean editorial financial-news aesthetic: one confident dominant color or subtle smooth gradient background, soft directional studio lighting, gentle depth of field and a light vignette, crisp premium color grading, sleek modern rendering (flat-vector or tasteful 3D). ' +
  'NO captions, NO title text, NO sentences, NO watermark, NO logos of exchanges, NO UI chrome, NO price labels, NO numbers, NO garbled letters. Full-bleed square 1:1, no border, no frame, no white margin.';

export function buildImagePrompt(title, { subject, answers = ['Yes', 'No'] } = {}) {
  return `Subject of the prediction: "${title}". (Outcomes: ${answers.join(' / ')}.)\n${MARKET_STYLE(subject)}`;
}

// Hero-subject heuristics (used when no Claude writer supplied `imageSubject`). Polymarket-style = ONE recognizable subject, no text.
// Real people are described by role/setting (podium, seal, flag) rather than likeness, so the image model never has to draw a face.
const SUBJECT_RULES = [
  [/bitcoin|\bbtc\b|비트코인/i, 'a giant glossy 3D Bitcoin coin with the ₿ glyph, orange and charcoal palette, soft rim light'],
  [/ethereum|\beth\b|이더리움/i, 'a floating 3D Ethereum diamond glyph in glass, deep violet-blue palette'],
  [/solana|\bsol\b|솔라나/i, 'a Solana gradient logo glyph in purple-to-teal, dark studio background'],
  [/\betf\b|exchange-traded|상장지수/i, 'a stylized stock-exchange ticker board pictogram with a rising line, navy and green palette'],
  [/\bfed\b|fomc|federal reserve|interest rate|rate cut|rate hike|금리|연준|기준금리/i, 'the Federal Reserve eagle seal rendered in brushed metal with a subtle interest-rate curve behind it, dark blue palette'],
  [/\bcpi\b|inflation|consumer price|물가|인플레이션/i, 'a stylized shopping-cart pictogram with a rising price curve, warm amber palette'],
  [/gdp|recession|unemployment|jobs report|경기침체|실업률|고용/i, 'a bold bar-chart pictogram with an arrow, slate and gold palette'],
  [/election|midterm|senate|house of representatives|congress|governor|primary|선거|대선|총선|의회|상원|하원/i, 'the US Capitol dome at dusk with a subtle flag-color gradient, cinematic'],
  [/president|백악관|white house|대통령/i, 'a presidential podium with a flag backdrop under spotlight, no visible person'],
  [/ceasefire|war|military|strike|troops|invasion|휴전|전쟁|군사|침공/i, 'a stylized globe with a pair of olive branches, muted steel-blue palette'],
  [/tariff|trade deal|sanction|관세|무역|제재/i, 'stacked shipping containers with a world-map silhouette, slate palette'],
  [/world cup|fifa|soccer|football club|premier league|champions league|la liga|serie a|bundesliga|축구|월드컵/i, 'a classic soccer ball on a floodlit pitch, green and white palette'],
  [/ballon d.?or|발롱도르/i, 'a golden football trophy on a dark velvet background'],
  [/\bnba\b|basketball|농구/i, 'a basketball mid-air under arena lights, orange and black palette'],
  [/\bnfl\b|super bowl|quarterback|touchdown|미식축구/i, 'an American football on a stadium field, dramatic lighting'],
  [/\bmlb\b|baseball|world series|야구/i, 'a baseball with red stitching on a dark background, stadium bokeh'],
  [/\bnhl\b|hockey|하키/i, 'a hockey puck and stick on ice, cold blue palette'],
  [/tennis|wimbledon|grand slam|테니스/i, 'a tennis ball on a grass court, bright green palette'],
  [/\bf1\b|formula 1|grand prix|포뮬러/i, 'a racing car front wing silhouette with motion blur, red and black palette'],
  [/\bufc\b|boxing|fight|복싱|격투/i, 'boxing gloves hanging in a ring under spotlight'],
  [/league of legends|\blol\b|worlds|esports|valorant|csgo|롤드컵|이스포츠|e스포츠/i, 'a glowing esports trophy on a neon-lit stage, purple and cyan palette'],
  [/oscar|academy award|golden globe|emmy|오스카|아카데미/i, 'a golden award statuette on a dark stage, warm spotlight'],
  [/grammy|billboard|album|single|chart|그래미|앨범|빌보드/i, 'a glossy vinyl record with warm stage light, gold and black palette'],
  [/box office|movie|film|premiere|영화|박스오피스/i, 'a cinema film reel with a projector beam, warm palette'],
  [/netflix|streaming|series|드라마|시리즈/i, 'a glowing television screen in a dark living room, teal palette'],
  [/spacex|starship|rocket|launch|nasa|artemis|로켓|발사|우주/i, 'a rocket lifting off on a plume of fire against a dark sky'],
  [/hottest|temperature|heat|climate|weather|hurricane|기온|폭염|기후|태풍/i, 'a stylized sun over a thermometer pictogram, amber and red gradient'],
  [/earthquake|volcano|flood|지진|화산|홍수/i, 'a dramatic cracked-earth landscape pictogram, muted palette'],
  [/openai|chatgpt|gpt|anthropic|claude|gemini|\bai\b|artificial intelligence|인공지능|모델/i, 'a glowing neural-network sphere of connected nodes, electric blue palette'],
  [/apple|iphone|ipad/i, 'a sleek smartphone silhouette on a dark surface, silver palette'],
  [/tesla|cybertruck|electric vehicle|\bev\b|전기차/i, 'a stylized electric car silhouette with a charging bolt, white and red palette'],
  [/nvidia|chip|semiconductor|반도체/i, 'a macro shot of a gleaming microchip, green-black palette'],
  [/tiktok|instagram|twitter|\bx\b|youtube|social media/i, 'a glowing smartphone with abstract notification bubbles, dark palette'],
  [/vaccine|covid|flu|pandemic|health|백신|독감|전염병/i, 'a medical cross with a stylized molecule, clean teal palette'],
  [/gold|금값/i, 'a stack of gold bullion bars under studio light'],
  [/oil|crude|opec|유가|원유/i, 'an oil barrel with a rising price line, dark amber palette'],
  [/dollar|usd|exchange rate|환율|원\/달러|달러/i, 'a giant bold dollar sign glyph in brushed metal, navy and silver palette'],
  [/korea|한국|서울/i, 'a stylized South Korean Taegeuk symbol in modern flat design, blue and red palette'],
  [/japan|일본|도쿄/i, 'a minimalist red sun disc on cream, modern flat design'],
  [/china|중국|베이징/i, 'a stylized red lantern in modern flat design, red and gold palette'],
];
const CATEGORY_SUBJECT = { Politics: 'a ballot box with a flag-color gradient, cinematic', Sports: 'a stadium under floodlights at night', Crypto: 'a glowing abstract blockchain cube, violet palette', Economics: 'a brushed-metal bull figurine with a rising chart line, navy palette', Culture: 'a spotlight on an empty stage with a microphone', Science: 'a glowing atom orbit pictogram, teal palette', Social: 'a stylized globe with soft connection arcs, slate palette', Other: 'a crystal ball on a dark surface, soft glow' };

/** Pick a single hero subject for the thumbnail from the question text (fallback: category default). */
export function subjectFor(text, categoryId) {
  const t = String(text || '');
  for (const [re, subject] of SUBJECT_RULES) if (re.test(t)) return subject;
  return CATEGORY_SUBJECT[categoryById(categoryId)?.name] || CATEGORY_SUBJECT.Other;
}

async function sharp() { try { return (await import('sharp')).default; } catch { return null; } }

export async function generateGemini(prompt, { size = 512 } = {}) {
  const { apiKey, model } = CONFIG.gemini; if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const res = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } } }),
  }), 90000, 'gemini');
  const j = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const img = (j?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!img) throw new Error('Gemini returned no image');
  const raw = Buffer.from(img.inlineData.data, 'base64');
  const S = await sharp(); if (!S) return raw;
  return S(raw).resize(size, size, { fit: 'cover', position: 'centre' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

// Category palette for the local fallback (Polyquest-ish dark tiles)
const PALETTE = { Politics: ['#1d2440', '#9fb4ff'], Sports: ['#0f1a0a', '#7ce85c'], Crypto: ['#2b1d0a', '#f0b429'], Economics: ['#0a1f26', '#5cc8f0'], Culture: ['#2a0f2a', '#e58cf0'], Science: ['#0a2320', '#5ce8c8'], Social: ['#26140a', '#f0a05c'], Other: ['#1b1c1f', '#a3a6ad'] };
export async function generateLocal({ categoryId, seedText = '', size = 512 } = {}) {
  const cat = categoryById(categoryId)?.name || 'Other'; const [bg, fg] = PALETTE[cat] || PALETTE.Other;
  const h = crypto.createHash('sha1').update(seedText).digest(); const r = (i, lo, hi) => lo + (h[i] / 255) * (hi - lo);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><radialGradient id="g" cx="${r(0, 25, 75)}%" cy="${r(1, 25, 75)}%" r="80%"><stop offset="0" stop-color="${fg}" stop-opacity=".95"/><stop offset=".55" stop-color="${fg}" stop-opacity=".25"/><stop offset="1" stop-color="${bg}" stop-opacity="1"/></radialGradient></defs><rect width="100%" height="100%" fill="${bg}"/><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${r(2, 20, 80)}%" cy="${r(3, 20, 80)}%" r="${r(4, 14, 26)}%" fill="${fg}" opacity=".85"/><circle cx="${r(5, 10, 90)}%" cy="${r(6, 10, 90)}%" r="${r(7, 4, 10)}%" fill="#e6e7ea" opacity=".6"/></svg>`;
  const S = await sharp(); if (!S) return Buffer.from(svg);
  return S(Buffer.from(svg)).jpeg({ quality: 86 }).toBuffer();
}

/** Returns { url, file, source } for a market spec. Never throws (falls back to a placeholder URL). */
export async function thumbnailFor(spec) {
  const key = crypto.createHash('sha1').update(String(spec.polymarket?.conditionId || spec.title)).digest('hex').slice(0, 16);
  const file = path.join(ensureDir(PATHS.thumbs), `${key}.jpg`);
  let source = 'cached';
  if (!fs.existsSync(file)) {
    try {
      if (CONFIG.gemini.apiKey) { const subject = spec.imageSubject || subjectFor(`${spec.polymarket?.question || ''} ${spec.title}`, spec.categoryId); fs.writeFileSync(file, await generateGemini(buildImagePrompt(spec.polymarket?.question || spec.title, { subject }))); source = 'gemini'; }
      else { fs.writeFileSync(file, await generateLocal({ categoryId: spec.categoryId, seedText: key })); source = 'local'; }
    } catch (e) {
      log.warn('thumbnail generation failed, using local tile:', e.message);
      try { fs.writeFileSync(file, await generateLocal({ categoryId: spec.categoryId, seedText: key })); source = 'local'; } catch { return { url: PLACEHOLDER, file: null, source: 'placeholder' }; }
    }
  }
  const base = CONFIG.dashboard.publicBaseUrl;
  if (!base) return { url: PLACEHOLDER, file, source: source + '+placeholder-url' };
  return { url: `${base}/thumbs/${key}.jpg`, file, source };
}
