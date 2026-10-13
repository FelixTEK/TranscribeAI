// Step 4 of docs/vad-test-plan.md: compute metrics from data/eval/long/results/*.json and write eval/results.md
// usage: bun data/eval/metrics.ts
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanSegments, type Segment } from "../src/prompt";
import { parseWhisperJson } from "../src/whisper";

const dir = resolve("data/eval"); // audio + raw outputs (git-ignored)
const evalDir = resolve("eval"); // scripts, refs, results (tracked)
const resDir = `${dir}/long/results`;

/** keep letters, combining marks (Thai vowels/tone marks!) and digits; drop spaces and punctuation */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");

/** Levenshtein with backtrace -> substitutions, deletions (missed ref chars), insertions (extra hyp chars) */
function edit(ref: string, hyp: string) {
  const a = Array.from(ref);
  const b = Array.from(hyp);
  const n = a.length;
  const m = b.length;
  const ops = new Uint8Array((n + 1) * (m + 1)); // 0 match/sub(diag) 1 deletion(up) 2 insertion(left)
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    ops[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    ops[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const up = prev[j] + 1;
      const left = cur[j - 1] + 1;
      if (diag <= up && diag <= left) {
        cur[j] = diag;
        ops[i * (m + 1) + j] = 0;
      } else if (up <= left) {
        cur[j] = up;
        ops[i * (m + 1) + j] = 1;
      } else {
        cur[j] = left;
        ops[i * (m + 1) + j] = 2;
      }
    }
    [prev, cur] = [cur, prev];
  }
  let i = n;
  let j = m;
  let S = 0;
  let D = 0;
  let I = 0;
  while (i > 0 || j > 0) {
    const op = ops[i * (m + 1) + j];
    if (op === 0) {
      if (a[i - 1] !== b[j - 1]) S++;
      i--;
      j--;
    } else if (op === 1) {
      D++;
      i--;
    } else {
      I++;
      j--;
    }
  }
  return { S, D, I, N: n, cer: (S + D + I) / n };
}

const textOf = (segs: Segment[]) => norm([...segs].sort((x, y) => x.start - y.start).map((s) => s.text).join(""));
const pct = (x: number) => (x * 100).toFixed(2) + "%";

interface Utt {
  kind: string;
  name?: string;
  start: number;
  end: number;
}
const out: string[] = [];
out.push("# ผลทดสอบ VAD / การตัดท่อน (ตามแผน docs/vad-test-plan.md)\n");
out.push(`สร้างโดย \`data/eval/metrics.ts\` เมื่อ ${new Date().toISOString()}\n`);
out.push(
  "การ normalize ข้อความ: ตัวพิมพ์เล็ก ตัดช่องว่างและเครื่องหมายวรรคตอน **เก็บสระ/วรรณยุกต์ภาษาไทยไว้** (ต่างจาก `score.py` รุ่นแรกที่ตัดเครื่องหมายเหล่านี้ทิ้ง)\n",
);

for (const label of ["L1", "L2"]) {
  const tl = JSON.parse(await Bun.file(`${dir}/long/timeline_${label}.json`).text());
  const utts: Utt[] = tl.timeline.filter((t: Utt) => t.kind === "utterance");
  const traps: Utt[] = tl.timeline.filter((t: Utt) => t.kind.endsWith("trap"));
  const ref = norm(tl.ref);
  out.push(`\n## ${label} (${(tl.duration / 60).toFixed(1)} นาที, ประโยค ${utts.length}, กับดัก ${traps.length}, ตัวอักษรเฉลย ${Array.from(ref).length})\n`);
  out.push("| config | CER | S | D | I | CER หลัง cleanSegments | ตัวอักษรในช่วงกับดัก | รอยตัดกลางประโยค | segment เฉลี่ย (s) | % ประโยคที่เริ่ม ±2s | เวลา (s) | VRAM สูงสุด (MiB) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const id of ["C1", "C2", "C3", "C3k", "C4", "C5"]) {
    const p = `${resDir}/${label}_${id}.json`;
    if (!existsSync(p)) {
      out.push(`| ${id} | (ยังไม่มีผล) |||||||||||`);
      continue;
    }
    const r = JSON.parse(await Bun.file(p).text());
    const segs: Segment[] = r.segments;
    const e = edit(ref, textOf(segs));
    const eClean = edit(ref, textOf(cleanSegments(segs.map((s) => ({ ...s })))));
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
    out.push(
      `| ${id} | ${pct(e.cer)} | ${e.S} | ${e.D} | ${e.I} | ${pct(eClean.cer)} | ${trapChars} | ${mid}/${bounds.length} | ${avg.toFixed(1)} | ${(near * 100).toFixed(0)}% | ${r.seconds} | ${r.peakVramMiB} (ฐาน ${r.baselineVramMiB}) |`,
    );
  }
}

out.push("\n## FLEURS 79 ประโยค (ไฟล์สั้นแยกกัน) คำนวณใหม่ด้วย normalize ที่เก็บสระ/วรรณยุกต์\n");
out.push("| run | โมเดล | VAD | CER |\n|---|---|---|---|");
const refs: Record<string, string> = JSON.parse(await Bun.file(`${evalDir}/refs.json`).text());
for (const [d, model, vad] of [["T1", "turbo", "ใช้"], ["T2", "turbo", "ไม่ใช้"], ["Y1", "Typhoon q8_0", "ใช้"], ["Y2", "Typhoon q8_0", "ไม่ใช้"]]) {
  let S = 0, D = 0, I = 0, N = 0;
  for (const [name, r] of Object.entries(refs)) {
    const p = `${dir}/${d}/${name}.wav.json`;
    const hyp = existsSync(p) ? textOf(parseWhisperJson(await Bun.file(p).arrayBuffer(), 0)) : "";
    const e = edit(norm(r), hyp);
    S += e.S; D += e.D; I += e.I; N += e.N;
  }
  out.push(`| ${d} | ${model} | ${vad} | ${pct((S + D + I) / N)} (S ${S}, D ${D}, I ${I}, N ${N}) |`);
}

writeFileSync(`${evalDir}/results.md`, out.join("\n") + "\n");
console.log(out.join("\n"));
readdirSync(resDir);
