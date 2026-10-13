// Three-language test: read test/TH.m4a, EN.m4a, ZH.m4a against the references in test/Text.txt.
// Runs C3 (Typhoon, chunked) and C4 (turbo, whole file) with the language fixed and with "auto".
// usage: bun data/eval/run_lang.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cutChunks, planChunks } from "../src/chunker";
import { run } from "../src/proc";
import type { Segment } from "../src/prompt";
import { parseWhisperJson, transcribeFiles } from "../src/whisper";

const root = resolve(".");
const WHISPER = `${root}/bin/whisper/Release/whisper-cli.exe`;
const VAD = `${root}/models/ggml-silero-v6.2.0.bin`;
const MODELS = {
  typhoon: `${root}/models/ggml-typhoon-large-v3-q8_0.bin`,
  turbo: `${root}/models/ggml-large-v3-turbo-q8_0.bin`,
};
const outDir = `${root}/data/eval/lang`;
mkdirSync(`${outDir}/results`, { recursive: true });

// ---- references: blocks like "TH {\n...\n}" ----
const refText = await Bun.file(`${root}/test/Text.txt`).text();
const refs: Record<string, string> = {};
for (const m of refText.matchAll(/^(TH|EN|ZH)\s*\{\s*\n([\s\S]*?)\n\s*\}/gm)) refs[m[1]] = m[2].trim();

// ---- edit distance over arrays (chars or words) with S/D/I ----
function edit<T>(a: T[], b: T[]) {
  const n = a.length, m = b.length;
  const ops = new Uint8Array((n + 1) * (m + 1));
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) { prev[j] = j; ops[j] = 2; }
  for (let i = 1; i <= n; i++) {
    cur[0] = i; ops[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), up = prev[j] + 1, left = cur[j - 1] + 1;
      if (diag <= up && diag <= left) { cur[j] = diag; ops[i * (m + 1) + j] = 0; }
      else if (up <= left) { cur[j] = up; ops[i * (m + 1) + j] = 1; }
      else { cur[j] = left; ops[i * (m + 1) + j] = 2; }
    }
    [prev, cur] = [cur, prev];
  }
  let i = n, j = m, S = 0, D = 0, I = 0;
  while (i > 0 || j > 0) {
    const op = ops[i * (m + 1) + j];
    if (op === 0) { if (a[i - 1] !== b[j - 1]) S++; i--; j--; }
    else if (op === 1) { D++; i--; }
    else { I++; j--; }
  }
  return { S, D, I, N: n, rate: n ? (S + D + I) / n : 0 };
}
/** keep letters, combining marks and digits (Thai vowels/tones!), drop spaces and punctuation */
const normChars = (s: string) => Array.from(s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ""));
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'\s]+/gu, " ").split(/\s+/).filter(Boolean);
// common traditional-only forms of characters that appear in the ZH reference
const TRAD = "漢語問貴張東這個國習難發請學們說麼嗎誰";

const LANGS = [
  { key: "TH", code: "th", file: "TH.m4a" },
  { key: "EN", code: "en", file: "EN.m4a" },
  { key: "ZH", code: "zh", file: "ZH.m4a" },
];
const CONFIGS = [
  { id: "C3", model: "typhoon" as const, chunked: true },
  { id: "C4", model: "turbo" as const, chunked: false },
];

const rows: string[] = [];
const texts: string[] = [];
for (const L of LANGS) {
  const wav = `${outDir}/${L.key}.wav`;
  await run(["ffmpeg", "-v", "error", "-y", "-i", `${root}/test/${L.file}`, "-ar", "16000", "-ac", "1", wav]);
  for (const c of CONFIGS) {
    for (const lang of [L.code, "auto"]) {
      const t0 = performance.now();
      let segs: Segment[] = [];
      let detected = "";
      if (c.chunked) {
        const plan = await planChunks(wav, {
          ffmpeg: "ffmpeg", vadBin: `${root}/bin/whisper/Release/whisper-vad-speech-segments.exe`, vadModel: VAD,
          maxSeconds: 25, dropSilenceSeconds: 2, keepSilence: false,
        });
        const dir = `${outDir}/tmp_${L.key}_${c.id}_${lang}`;
        const files = await cutChunks(wav, plan.chunks, dir, "ffmpeg");
        await transcribeFiles({ whisper: WHISPER, model: MODELS[c.model], lang, files });
        const det = new Set<string>();
        for (let i = 0; i < files.length; i++) {
          const buf = await Bun.file(`${files[i]}.json`).arrayBuffer();
          det.add(JSON.parse(Buffer.from(buf).toString("latin1")).result?.language ?? "?");
          const s = parseWhisperJson(buf, plan.chunks[i].start);
          segs.push(...s);
        }
        detected = [...det].join("+");
        rmSync(dir, { recursive: true, force: true });
      } else {
        const base = `${outDir}/tmp_${L.key}_${c.id}_${lang}`;
        await run([WHISPER, "-m", MODELS[c.model], "-f", wav, "-l", lang, "-mc", "0", "-np", "-oj", "-of", base]);
        const buf = await Bun.file(`${base}.json`).arrayBuffer();
        detected = JSON.parse(Buffer.from(buf).toString("latin1")).result?.language ?? "?";
        segs = parseWhisperJson(buf, 0);
        rmSync(`${base}.json`, { force: true });
      }
      const secs = (performance.now() - t0) / 1000;
      const hyp = segs.map((s) => s.text).join(L.key === "EN" ? " " : "");
      const cer = edit(normChars(refs[L.key]), normChars(hyp));
      const wer = L.key === "EN" ? edit(words(refs[L.key]), words(hyp)) : null;
      const trad = L.key === "ZH" ? Array.from(hyp).filter((ch) => TRAD.includes(ch)).length : 0;
      writeFileSync(`${outDir}/results/${L.key}_${c.id}_${lang}.json`, JSON.stringify({ L, c, lang, detected, secs, hyp, segs }, null, 1));
      rows.push(
        `| ${L.key} | ${c.id} (${c.model}) | ${lang} | ${detected} | ${(cer.rate * 100).toFixed(1)}% (S${cer.S} D${cer.D} I${cer.I} /${cer.N}) | ${wer ? `${(wer.rate * 100).toFixed(1)}% (S${wer.S} D${wer.D} I${wer.I} /${wer.N})` : "-"} | ${trad || "-"} | ${secs.toFixed(0)} |`,
      );
      texts.push(`### ${L.key} · ${c.id} · lang=${lang} (detected ${detected})\n${hyp}\n`);
      console.log(rows.at(-1));
    }
  }
  texts.push(`### ${L.key} · เฉลย\n${refs[L.key]}\n`);
}

const md = [
  "# ผลทดสอบ 3 ภาษา (เสียงพูดของผู้ใช้)\n",
  "| ภาษา | config | -l | ภาษาที่ตรวจพบ | CER | WER (อังกฤษ) | ตัวอักษรจีนตัวเต็ม | เวลา (s) |",
  "|---|---|---|---|---|---|---|---|",
  ...rows,
  "\n## ข้อความที่ถอดได้\n",
  ...texts,
].join("\n");
writeFileSync(`${root}/eval/results-lang.md`, md + "\n");
console.log("\nwrote eval/results-lang.md");
