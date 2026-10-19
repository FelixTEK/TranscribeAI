// Experiments on the chunked Typhoon pipeline (C3):
//   beam   greedy vs beam search on LT:  -bs 1 / 2 / 5      (5 = whisper-cli default, what the app uses)
//   hill   steepest-ascent Hill-Climbing over (max chunk seconds, silence-drop seconds) on LD (dev),
//          then the best setting and the default are both scored once on LT (test)
// usage: bun eval/run_search.ts beam|hill|all     (run from the repo root; needs the GPU, one run at a time)
// Needs data/eval/long/{LD,LT}.wav (bun eval/make_long.ts split) and, for the bs=5 / default points, the C3 results
// of `bun eval/run_long.ts C3 LD,LT`.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cutChunks, planChunks, type ChunkConfig } from "../src/chunker";
import type { Segment } from "../src/prompt";
import { parseWhisperJson, transcribeFiles } from "../src/whisper";
import { edit } from "./cer";
import { normText } from "./normalize";

const root = resolve(".");
const WHISPER = `${root}/bin/whisper/Release/whisper-cli.exe`;
const VAD = `${root}/models/ggml-silero-v6.2.0.bin`;
const MODEL = `${root}/models/ggml-typhoon-large-v3-q8_0.bin`;
const outDir = `${root}/data/eval/search`;
mkdirSync(outDir, { recursive: true });

const logLines: string[] = [];
const log = (s: string) => {
  const line = `[${new Date().toLocaleTimeString("en-GB")}] ${s}`;
  console.log(line);
  logLines.push(line);
  writeFileSync(`${outDir}/run.log`, logLines.join("\n") + "\n");
};

interface Point { max: number; drop: number; beam: number }
interface Score { label: string; max: number; drop: number; beam: number; cer: number; S: number; D: number; I: number; N: number; seconds: number; chunks: number }

// `repeat` mode re-runs the app's default setting on LT once more (never reading the cache) to measure run-to-run noise
const REPEAT = process.argv[2] === "repeat";
const key = (p: Point) => `m${p.max}_d${p.drop}_bs${p.beam}${REPEAT ? "_rep" : ""}`;
const refOf = async (label: string) => normText(JSON.parse(await Bun.file(`${root}/data/eval/long/timeline_${label}.json`).text()).ref);
const score = async (label: string, segs: Segment[], p: Point, seconds: number, chunks: number): Promise<Score> => {
  const hyp = normText([...segs].sort((a, b) => a.start - b.start).map((s) => s.text).join(""));
  const e = edit(await refOf(label), hyp);
  return { label, ...p, cer: e.cer, S: e.S, D: e.D, I: e.I, N: e.N, seconds, chunks };
};

/** Score one setting on one file; cached on disk. The app's default (25 s, 2 s, beam 5) is read from the run_long C3 result. */
async function evaluate(label: "LD" | "LT", p: Point): Promise<Score> {
  const cache = `${outDir}/${label}_${key(p)}.json`;
  if (existsSync(cache)) return JSON.parse(await Bun.file(cache).text());
  const c3 = `${root}/data/eval/long/results/${label}_C3.json`;
  let result: Score;
  if (!REPEAT && p.max === 25 && p.drop === 2 && p.beam === 5 && existsSync(c3)) {
    const r = JSON.parse(await Bun.file(c3).text());
    result = await score(label, r.segments, p, r.seconds, r.chunks);
  } else {
    const wav = `${root}/data/eval/long/${label}.wav`;
    const cc: ChunkConfig = {
      ffmpeg: "ffmpeg", vadBin: `${root}/bin/whisper/Release/whisper-vad-speech-segments.exe`, vadModel: VAD,
      maxSeconds: p.max, dropSilenceSeconds: p.drop, keepSilence: false,
    };
    const t0 = performance.now();
    const plan = await planChunks(wav, cc);
    const dir = `${outDir}/tmp_${label}_${key(p)}`;
    const files = await cutChunks(wav, plan.chunks, dir, "ffmpeg");
    await transcribeFiles({ whisper: WHISPER, model: MODEL, files, extraArgs: ["-bs", String(p.beam)] });
    const segments: Segment[] = [];
    for (let i = 0; i < files.length; i++) {
      const segs = parseWhisperJson(await Bun.file(`${files[i]}.json`).arrayBuffer(), plan.chunks[i].start);
      if (segs.length === 1) {
        segs[0].start = plan.chunks[i].start;
        segs[0].end = plan.chunks[i].end;
      }
      segments.push(...segs);
    }
    rmSync(dir, { recursive: true, force: true });
    result = await score(label, segments, p, (performance.now() - t0) / 1000, plan.chunks.length);
  }
  writeFileSync(cache, JSON.stringify(result, null, 1));
  log(`${label} ${key(p)}: CER ${(result.cer * 100).toFixed(2)}% (S ${result.S} D ${result.D} I ${result.I}), ${result.seconds.toFixed(0)} s, ${result.chunks} chunks`);
  return result;
}

const pct = (x: number) => (x * 100).toFixed(2) + "%";
const md: string[] = [];
/** structured copy of the results, read by eval/charts.py */
const data: Record<string, unknown> = {};

async function beam() {
  const beamRows: unknown[] = [];
  data.beam = beamRows;
  md.push("## Greedy เทียบ beam search (C3, ชุดทดสอบ LT)\n");
  md.push("| beam size (`-bs`) | CER (ตัวเลข) | S | D | I | เวลา (วินาที) |\n|---|---|---|---|---|---|");
  for (const b of [1, 2, 5]) {
    const s = await evaluate("LT", { max: 25, drop: 2, beam: b });
    beamRows.push({ beam: b, cer: s.cer, S: s.S, D: s.D, I: s.I, seconds: s.seconds });
    md.push(`| ${b}${b === 1 ? " (greedy)" : b === 5 ? " (ค่าเริ่มต้น ที่แอปใช้)" : ""} | ${pct(s.cer)} | ${s.S} | ${s.D} | ${s.I} | ${s.seconds.toFixed(0)} |`);
  }
  md.push("");
}

async function hill() {
  const MAXS = [10, 15, 20, 25, 30];
  const DROPS = [0.5, 1, 1.5, 2, 2.5, 3];
  const neighbours = (p: Point): Point[] => {
    const i = MAXS.indexOf(p.max);
    const j = DROPS.indexOf(p.drop);
    const out: Point[] = [];
    if (i > 0) out.push({ ...p, max: MAXS[i - 1] });
    if (i < MAXS.length - 1) out.push({ ...p, max: MAXS[i + 1] });
    if (j > 0) out.push({ ...p, drop: DROPS[j - 1] });
    if (j < DROPS.length - 1) out.push({ ...p, drop: DROPS[j + 1] });
    return out;
  };
  const MIN_GAIN = 0.002; // an improvement under 0.2 CER points counts as a plateau (single runs are noisy)
  let cur: Point = { max: 25, drop: 2, beam: 5 };
  let curScore = await evaluate("LD", cur);
  const path = [{ ...cur, cer: curScore.cer, step: 0 }];
  const tried: { p: Point; cer: number }[] = [{ p: cur, cer: curScore.cer }];
  let stopReason = "ครบ 4 รอบ";
  for (let step = 1; step <= 4; step++) {
    let best: { p: Point; s: Score } | undefined;
    for (const n of neighbours(cur)) {
      if (tried.some((t) => key(t.p) === key(n))) continue;
      const s = await evaluate("LD", n);
      tried.push({ p: n, cer: s.cer });
      if (!best || s.cer < best.s.cer) best = { p: n, s };
    }
    if (!best || curScore.cer - best.s.cer < MIN_GAIN) {
      stopReason = "ไม่มีเพื่อนบ้านที่ดีกว่าอย่างมีนัยสำคัญ (local maximum หรือ plateau)";
      break;
    }
    cur = best.p;
    curScore = best.s;
    path.push({ ...cur, cer: curScore.cer, step });
  }
  const start: Point = { max: 25, drop: 2, beam: 5 };
  data.hill = { path, tried: tried.map((t) => ({ max: t.p.max, drop: t.p.drop, cer: t.cer })), stopReason, grid: MAXS.length * DROPS.length };
  md.push("## Hill-Climbing ปรับค่าตัดท่อนบนชุดปรับค่า LD (dev)\n");
  md.push("state = (ความยาวท่อนสูงสุด วินาที, เกณฑ์ทิ้งเงียบ วินาที) · h = CER (ตัวเลข) บน LD · เพื่อนบ้าน = ขยับค่าใดค่าหนึ่งหนึ่งขั้น · แบบ steepest-ascent (ประเมินเพื่อนบ้านทั้งหมด เลือกตัวดีที่สุด)\n");
  md.push("| รอบ | ความยาวท่อน | เกณฑ์ทิ้งเงียบ | CER บน LD |\n|---|---|---|---|");
  for (const p of path) md.push(`| ${p.step} | ${p.max} | ${p.drop} | ${pct(p.cer)} |`);
  md.push(`\nหยุดเพราะ: ${stopReason} · ประเมินทั้งหมด ${tried.length} จุด (ตารางเต็ม ${MAXS.length * DROPS.length} จุด)\n`);
  md.push("จุดที่ลองทั้งหมดบน LD:\n");
  md.push("| ความยาวท่อน | เกณฑ์ทิ้งเงียบ | CER บน LD |\n|---|---|---|");
  for (const t of tried) md.push(`| ${t.p.max} | ${t.p.drop} | ${pct(t.cer)} |`);
  md.push("\n### ชุดทดสอบ LT (รายงานครั้งเดียว ไม่ได้ใช้เลือกค่า)\n");
  md.push("| ค่า | ความยาวท่อน | เกณฑ์ทิ้งเงียบ | CER (ตัวเลข) บน LT |\n|---|---|---|---|");
  const t0 = await evaluate("LT", start);
  const testData: Record<string, unknown> = { default: { ...start, cer: t0.cer } };
  data.hillTest = testData;
  md.push(`| ค่าเริ่มต้น | ${start.max} | ${start.drop} | ${pct(t0.cer)} |`);
  if (key(cur) !== key(start)) {
    const t1 = await evaluate("LT", cur);
    testData.chosen = { ...cur, cer: t1.cer };
    md.push(`| ค่าที่ Hill-Climbing เลือก | ${cur.max} | ${cur.drop} | ${pct(t1.cer)} |`);
  } else {
    md.push("| ค่าที่ Hill-Climbing เลือก | (เหมือนค่าเริ่มต้น) | | |");
  }
  md.push("\nความต่างน้อยกว่า ~0.5 จุด CER ถือว่าไม่ต่าง (รันครั้งเดียว ไฟล์ละ ~9.7 นาที)\n");
}

async function repeat() {
  const first = await evaluate("LT", { max: 25, drop: 2, beam: 5 }).catch(() => undefined);
  // REPEAT is set, so this key is "..._rep" and is computed afresh
  const prev = JSON.parse(await Bun.file(`${root}/data/eval/long/results/LT_C3.json`).text());
  const before = await score("LT", prev.segments, { max: 25, drop: 2, beam: 5 }, prev.seconds, prev.chunks);
  md.push("## ความแกว่งระหว่างรัน (ค่าเริ่มต้น C3 บน LT รันสองครั้ง)\n");
  md.push("| ครั้งที่ | CER (ตัวเลข) | S | D | I |\n|---|---|---|---|---|");
  md.push(`| 1 | ${pct(before.cer)} | ${before.S} | ${before.D} | ${before.I} |`);
  if (first) md.push(`| 2 | ${pct(first.cer)} | ${first.S} | ${first.D} | ${first.I} |`);
  md.push("");
  data.repeat = { first: before, second: first };
}

const mode = process.argv[2] ?? "all";
md.push("# ผลการทดลองค้นหา: beam search และ Hill-Climbing\n");
md.push(`สร้างโดย \`eval/run_search.ts\` เมื่อ ${new Date().toISOString()}\n`);
if (mode === "beam" || mode === "all") await beam();
if (mode === "hill" || mode === "all") await hill();
if (mode === "repeat") await repeat();
const suffix = mode === "repeat" ? "-repeat" : "";
writeFileSync(`${root}/eval/search${suffix}-results.md`, md.join("\n") + "\n");
writeFileSync(`${root}/eval/search${suffix}-data.json`, JSON.stringify(data, null, 1) + "\n");
log("ALL DONE");
