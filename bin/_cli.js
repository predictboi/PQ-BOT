// tiny arg parser shared by bin scripts: --flag, --key value, positionals
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true; } else out._.push(a); }
  return out;
}
export const die = (msg) => { console.error(msg); process.exit(1); };
export const pj = (o) => console.log(JSON.stringify(o, null, 2));
