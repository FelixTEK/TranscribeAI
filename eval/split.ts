// Split the 79 FLEURS utterances into a dev set (used to tune settings) and a test set (reported once).
// usage: bun eval/split.ts   -> writes eval/split.json (fixed seed, so the split is reproducible)
import { readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SEED = 2026;
const DEV_SIZE = 40;

function rng(seed: number) {
  // mulberry32, same generator as make_long.ts
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const names = readdirSync(resolve("data/eval/w16"))
  .filter((f) => f.endsWith(".wav"))
  .map((f) => f.replace(".wav", ""))
  .sort();

// Fisher-Yates shuffle with the fixed seed
const r = rng(SEED);
const shuffled = [...names];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(r() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const dev = shuffled.slice(0, DEV_SIZE).sort();
const test = shuffled.slice(DEV_SIZE).sort();

writeFileSync(resolve("eval/split.json"), JSON.stringify({ seed: SEED, dev, test }, null, 1) + "\n");
console.log(`split ${names.length} utterances: dev ${dev.length}, test ${test.length} (seed ${SEED})`);
