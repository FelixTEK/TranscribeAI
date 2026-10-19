// Step 4 of docs/vad-test-plan.md: compute metrics from data/eval/long/results/*.json and write eval/results.md
// usage: bun eval/metrics.ts   (run from the repo root)
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanSegments, type Segment } from "../src/prompt";
import { parseWhisperJson } from "../src/whisper";
import { edit } from "./cer";
import { normRaw, normText } from "./normalize";

const dir = resolve("data/eval"); // audio + raw outputs (git-ignored)
const evalDir = resolve("eval"); // scripts, refs, results (tracked)
const resDir = `${dir}/long/results`;

/** Raw normalisation: keep letters, combining marks (Thai vowels/tone marks!) and digits; drop spaces and punctuation.
 *  `normText` also turns Thai number words into digits (eval/normalize.ts); CER is reported with both. */
const norm = normRaw;


const textOf = (segs: Segment[], n: (s: string) => string = norm) =>
  n([...segs].sort((x, y) => x.start - y.start).map((s) => s.text).join(""));
const pct = (x: number) => (x * 100).toFixed(2) + "%";

interface Utt {
  kind: string;
  name?: string;
  start: number;
  end: number;
}
const out: string[] = [];
/** structured copy of the long-file tables, read by eval/charts.py */
const chartData: Record<string, Record<string, unknown>> = {};
out.push("# ผลทดสอบ VAD / การตัดท่อน (ตามแผน docs/vad-test-plan.md)\n");
out.push(`สร้างโดย \`eval/metrics.ts\` เมื่อ ${new Date().toISOString()}\n`);
out.push(
  "การ normalize ข้อความ: ตัวพิมพ์เล็ก ตัดช่องว่างและเครื่องหมายวรรคตอน **เก็บสระ/วรรณยุกต์ภาษาไทยไว้** (ต่างจาก `score.py` รุ่นแรกที่ตัดเครื่องหมายเหล่านี้ทิ้ง)\n",
);
out.push(
  'คอลัมน์ **CER** = normalize แบบข้างบนอย่างเดียว · คอลัมน์ **CER (ตัวเลข)** = แปลงคำอ่านตัวเลขไทย (เช่น "สองพันห้าร้อยสามสิบแปด") เป็นเลขอารบิก ทั้งฝั่งเฉลยและผลถอดเสียง ก่อนเทียบ (`eval/normalize.ts`)\n',
);

for (const label of ["L1", "L2", "LD", "LT"]) {
  if (!existsSync(`${dir}/long/timeline_${label}.json`)) continue;
  const tl = JSON.parse(await Bun.file(`${dir}/long/timeline_${label}.json`).text());
  const utts: Utt[] = tl.timeline.filter((t: Utt) => t.kind === "utterance");
  const traps: Utt[] = tl.timeline.filter((t: Utt) => t.kind.endsWith("trap"));
  const ref = norm(tl.ref);
  const refN = normText(tl.ref);
  out.push(`\n## ${label} (${(tl.duration / 60).toFixed(1)} นาที, ประโยค ${utts.length}, กับดัก ${traps.length}, ตัวอักษรเฉลย ${Array.from(ref).length})\n`);
  out.push("| config | CER | CER (ตัวเลข) | S | D | I | CER หลัง cleanSegments | ตัวอักษรในช่วงกับดัก | รอยตัดกลางประโยค | segment เฉลี่ย (s) | % ประโยคที่เริ่ม ±2s | เวลา (s) | VRAM สูงสุด (MiB) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const id of ["C1", "C2", "C3", "C3k", "C4", "C5"]) {
    const p = `${resDir}/${label}_${id}.json`;
    if (!existsSync(p)) {
      out.push(`| ${id} | (ยังไม่มีผล) ||||||||||||`);
      continue;
    }
    const r = JSON.parse(await Bun.file(p).text());
    const segs: Segment[] = r.segments;
    const e = edit(ref, textOf(segs));
    const eNum = edit(refN, textOf(segs, normText));
    const eClean =edit(ref, textOf(cleanSegments(segs.map((s) => ({ ...s })))));
    // characters Whisper produced in segments that sit mostly (> 50 %) inside a trap
    let trapChars = 0;
    for (const s of segs) {
      const dur = Math.max(1e-6, s.end - s.start);
      for (const t of traps) {
        const ov = Math.max(0, Math.min(s.end, t.end) - Math.max(s.start, t.start));
        if (ov / dur > 0.5) {
          trapChars += Array.from(norm(s.text)).length;
          break;
        }
      }
    }
    // segment boundaries that fall inside a sentence
    const sorted = [...segs].sort((x, y) => x.start - y.start);
    const bounds = sorted.slice(0, -1).map((s) => s.end);
    const mid = bounds.filter((b) => utts.some((u) => b > u.start + 0.1 && b < u.end - 0.1)).length;
    const avg = sorted.reduce((n, s) => n + (s.end - s.start), 0) / Math.max(1, sorted.length);
    const near = utts.filter((u) => sorted.some((s) => Math.abs(s.start - u.start) <= 2)).length / utts.length;
    (chartData[label] ??= {})[id] = {
      cer: e.cer, cerNum: eNum.cer, S: e.S, D: e.D, I: e.I, N: e.N, seconds: r.seconds, vramMiB: r.peakVramMiB, trapChars,
    };
    out.push(
      `| ${id} | ${pct(e.cer)} | ${pct(eNum.cer)} | ${e.S} | ${e.D} | ${e.I} | ${pct(eClean.cer)} | ${trapChars} | ${mid}/${bounds.length} | ${avg.toFixed(1)} | ${(near * 100).toFixed(0)}% | ${r.seconds} | ${r.peakVramMiB} (ฐาน ${r.baselineVramMiB}) |`,
    );
  }
}

out.push("\n## FLEURS 79 ประโยค (ไฟล์สั้นแยกกัน) คำนวณใหม่ด้วย normalize ที่เก็บสระ/วรรณยุกต์\n");
out.push("| run | โมเดล | VAD | CER | CER (ตัวเลข) |\n|---|---|---|---|---|");
const refs: Record<string, string> = JSON.parse(await Bun.file(`${evalDir}/refs.json`).text());
for (const [d, model, vad] of [["T1", "turbo", "ใช้"], ["T2", "turbo", "ไม่ใช้"], ["Y1", "Typhoon q8_0", "ใช้"], ["Y2", "Typhoon q8_0", "ไม่ใช้"]]) {
  let S = 0, D = 0, I = 0, N = 0, errN = 0, totN = 0;
  for (const [name, r] of Object.entries(refs)) {
    const p = `${dir}/${d}/${name}.wav.json`;
    const hyp = existsSync(p) ? textOf(parseWhisperJson(await Bun.file(p).arrayBuffer(), 0)) : "";
    const e = edit(norm(r), hyp);
    S += e.S; D += e.D; I += e.I; N += e.N;
    const hypN = existsSync(p) ? textOf(parseWhisperJson(await Bun.file(p).arrayBuffer(), 0), normText) : "";
    const eN = edit(normText(r), hypN);
    errN += eN.S + eN.D + eN.I; totN += eN.N;
  }
  out.push(`| ${d} | ${model} | ${vad} | ${pct((S + D + I) / N)} (S ${S}, D ${D}, I ${I}, N ${N}) | ${pct(errN / totN)} |`);
}

writeFileSync(`${evalDir}/results.md`, out.join("\n") + "\n");
writeFileSync(`${evalDir}/chart-data.json`, JSON.stringify(chartData, null, 1) + "\n");
console.log(out.join("\n"));
readdirSync(resDir);
