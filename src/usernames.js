// Natural-looking display names for the bot wallets (set through the My Page pencil edit: user.updateName).
// Platform rule (frontend schema): 2–24 chars, letters, numbers, spaces, underscores, periods, hyphens.
import { rng, hashStr } from './organic.js';

export const NAME_RE = /^[A-Za-z0-9 _.-]{2,24}$/;

const FIRST = ['alex', 'sam', 'jordan', 'chris', 'mike', 'dan', 'ben', 'nick', 'tom', 'ryan', 'kevin', 'eric', 'josh', 'matt', 'leo', 'max', 'sean', 'tony', 'jake', 'luke',
  'emma', 'olivia', 'mia', 'chloe', 'grace', 'lily', 'zoe', 'nina', 'kate', 'anna', 'jess', 'amy', 'sara', 'ella', 'ruby', 'ivy',
  'minjun', 'jiho', 'seoyeon', 'hana', 'yuna', 'jisoo', 'taeho', 'sora', 'kenji', 'yuki', 'haru', 'mei', 'wei', 'arjun', 'ravi', 'priya', 'diego', 'mateo', 'lucas', 'marco', 'felix', 'omar', 'ines', 'lena'];
const LAST = ['kim', 'lee', 'park', 'choi', 'jung', 'tanaka', 'sato', 'chen', 'wang', 'nguyen', 'patel', 'garcia', 'silva', 'rossi', 'muller', 'smith', 'brown', 'miller', 'davis', 'walker', 'reyes', 'cole', 'hayes', 'ford'];
const ADJ = ['lazy', 'quiet', 'lucky', 'sleepy', 'salty', 'cosmic', 'midnight', 'rainy', 'humble', 'rogue', 'golden', 'frosty', 'mellow', 'swift', 'odd', 'tiny', 'grumpy', 'sunny'];
const NOUN = ['fox', 'otter', 'panda', 'river', 'owl', 'tiger', 'falcon', 'maple', 'pine', 'comet', 'pixel', 'walrus', 'koala', 'badger', 'raven', 'lynx', 'mango', 'cactus'];
const TOPIC = ['macro', 'stats', 'hoops', 'gridiron', 'pitch', 'chain', 'sats', 'eth', 'polls', 'odds', 'fade', 'value', 'chart', 'alpha', 'degen', 'quant', 'whale', 'contra'];
const TAIL = ['guy', 'nerd', 'head', 'watcher', 'daily', 'takes', 'brain', 'enjoyer', 'fan', 'kid', 'lab', 'desk'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** One candidate name from a PRNG; a mix of styles so the set doesn't look templated. */
function candidate(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const yy = () => String(80 + Math.floor(r() * 25)).slice(-2);
  const n2 = () => String(Math.floor(r() * 100));
  switch (Math.floor(r() * 10)) {
    case 0: return `${pick(FIRST)}${pick(LAST)}`;                         // minjunpark
    case 1: return `${pick(FIRST)}_${pick(LAST)}`;                        // emma_rossi
    case 2: return `${pick(FIRST)}.${pick(LAST)[0]}`;                     // kate.w
    case 3: return `${pick(FIRST)}${yy()}`;                               // ryan94
    case 4: return `${pick(ADJ)}${pick(NOUN)}`;                           // sleepyotter
    case 5: return `${pick(ADJ)}_${pick(NOUN)}${r() < 0.5 ? n2() : ''}`;  // salty_walrus7
    case 6: return `${pick(TOPIC)}${pick(TAIL)}`;                         // statsnerd
    case 7: return `${pick(TOPIC)}_${pick(FIRST)}`;                       // macro_mia
    case 8: return `${cap(pick(FIRST))} ${cap(pick(LAST))[0]}`;           // Leo K
    default: return `${pick(FIRST)}${pick(FIRST)[0]}${r() < 0.5 ? n2() : ''}`; // jisook3
  }
}

/** Deterministic unique names for the given labels (same salt → same names). */
export function generateNames(labels, { salt = 'v1' } = {}) {
  const used = new Set(); const out = {};
  for (const label of labels) {
    const r = rng(hashStr(`${salt}:${label}`)); let name;
    do { name = candidate(r); } while (!NAME_RE.test(name) || used.has(name.toLowerCase()));
    used.add(name.toLowerCase()); out[label] = name;
  }
  return out;
}
