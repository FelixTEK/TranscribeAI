// Build the long test files from the 79 FLEURS utterances in data/eval/w16 (see docs/vad-test-plan.md, section 2).
//   L1: random pauses 0.3-1.0 s + 6 traps (3 x digital silence, 3 x pink noise at ~-40 dBFS)
//   L2: continuous speech, pauses 0.1-0.2 s, no traps
// usage: bun data/eval/make_long.ts
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve("data/eval"); // audio + raw outputs (git-ignored)
const evalDir = resolve("eval"); // scripts, refs, results (tracked)
const out = `${dir}/long`;
mkdirSync(out, { recursive: true });
const refs: Record<string, string> = JSON.parse(await Bun.file(`${evalDir}/refs.json`).text());
const names = readdirSync(`${dir}/w16`).filter((f) => f.endsWith(".wav")).map((f) => f.replace(".wav", "")).sort();

const SR = 16000;
function rng(seed: number) {
  // mulberry32
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function pcm(args: string[]): Promise<Int16Array> {
  const p = Bun.spawn(["ffmpeg", "-v", "error", ...args, "-f", "s16le", "-ac", "1", "-ar", String(SR), "-"], { stdout: "pipe" });
  const b = Buffer.from(await new Response(p.stdout).arrayBuffer());
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 2)));
}
const rmsDb = (a: Int16Array) => {
  let s = 0;
  for (const v of a) s += v * v;
  return 20 * Math.log10(Math.sqrt(s / a.length) / 32768);
};
function wavBytes(samples: Int16Array): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const utter = new Map<string, Int16Array>();
for (const n of names) utter.set(n, await pcm(["-i", `${dir}/w16/${n}.wav`]));

type Piece = { kind: "utterance" | "pause" | "silence-trap" | "noise-trap"; name?: string; samples: Int16Array };
const traps: Record<number, { kind: "silence-trap" | "noise-trap"; seconds: number }> = {
  9: { kind: "silence-trap", seconds: 25 },
  21: { kind: "noise-trap", seconds: 20 },
  33: { kind: "silence-trap", seconds: 30 },
  45: { kind: "noise-trap", seconds: 20 },
  57: { kind: "silence-trap", seconds: 20 },
  69: { kind: "noise-trap", seconds: 20 },
};

async function build(label: "L1" | "L2") {
  const r = rng(label === "L1" ? 1234 : 5678);
  const pieces: Piece[] = [];
  for (let i = 0; i < names.length; i++) {
    pieces.push({ kind: "utterance", name: names[i], samples: utter.get(names[i])! });
    if (i === names.length - 1) break;
    const lo = label === "L1" ? 0.3 : 0.1;
    const hi = label === "L1" ? 1.0 : 0.2;
    pieces.push({ kind: "pause", samples: new Int16Array(Math.round((lo + r() * (hi - lo)) * SR)) });
    const trap = label === "L1" ? traps[i] : undefined;
    if (trap) {
      const samples =
        trap.kind === "silence-trap"
          ? new Int16Array(trap.seconds * SR)
          : await pcm(["-f", "lavfi", "-i", `anoisesrc=d=${trap.seconds}:c=pink:a=0.05:r=${SR}:seed=7`]);
      pieces.push({ kind: trap.kind, samples });
    }
  }
  const total = pieces.reduce((n, p) => n + p.samples.length, 0);
  const all = new Int16Array(total);
  const timeline: any[] = [];
  let at = 0;
  for (const p of pieces) {
    all.set(p.samples, at);
    const t = { kind: p.kind, name: p.name, start: at / SR, end: (at + p.samples.length) / SR } as any;
    if (p.kind === "noise-trap") t.rmsDbfs = Number(rmsDb(p.samples).toFixed(1));
    if (p.kind !== "pause") timeline.push(t);
    at += p.samples.length;
  }
  writeFileSync(`${out}/${label}.wav`, wavBytes(all));
  const utts = timeline.filter((t) => t.kind === "utterance");
  const ref = utts.map((t) => refs[t.name]).join("");
  writeFileSync(`${out}/timeline_${label}.json`, JSON.stringify({ label, duration: total / SR, timeline, ref }, null, 1));
  console.log(`${label}: ${(total / SR / 60).toFixed(2)} min, ${utts.length} utterances, ${timeline.length - utts.length} traps`,
    timeline.filter((t) => t.kind.endsWith("trap")).map((t) => `${t.kind.split("-")[0]}@${t.start.toFixed(0)}s(${(t.end - t.start).toFixed(0)}s${t.rmsDbfs ? `, ${t.rmsDbfs}dBFS` : ""})`).join(" "));
}
await build("L1");
await build("L2");
