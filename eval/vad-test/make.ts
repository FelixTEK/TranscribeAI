// Dump what the VAD chunker keeps and drops, as audio files + an HTML page to listen to them.
// usage: bun data/vad-test/make.ts <audio file> [max chunk seconds]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".");
const src = resolve(process.argv[2]);
const out = resolve("data/vad-test/out");
const MAX = Number(process.argv[3] ?? 25);
const PAD = 0.15;
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/kept`, { recursive: true });
mkdirSync(`${out}/dropped`, { recursive: true });

const sh = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [o, e, c] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (c) throw new Error(cmd[0] + ": " + e.slice(-300));
  return o;
};

const wav = `${out}/full.wav`;
await sh(["ffmpeg", "-v", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", wav]);
const dur = Number((await sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav])).trim());

const vadOut = await sh([
  `${root}/bin/whisper/Release/whisper-vad-speech-segments.exe`, "-f", wav,
  "-vm", `${root}/models/ggml-silero-v6.2.0.bin`, "-np",
]);
// "Speech segment 3: start = 1037.00, end = 1101.00" (centiseconds)
const spans = [...vadOut.matchAll(/start = ([\d.]+), end = ([\d.]+)/g)].map((m) => ({ start: +m[1] / 100, end: +m[2] / 100 }));

// ---- energy envelope (10 ms frames) used to cut inside long continuous speech ----
const pcmProc = Bun.spawn(["ffmpeg", "-v", "error", "-i", wav, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], { stdout: "pipe" });
const pcm = Buffer.from(await new Response(pcmProc.stdout).arrayBuffer());
const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
const FR = 160;
const nfr = Math.floor(samples.length / FR);
const rms = new Float64Array(nfr);
for (let i = 0; i < nfr; i++) {
  let a = 0;
  for (let k = 0; k < FR; k++) { const v = samples[i * FR + k]; a += v * v; }
  rms[i] = Math.sqrt(a / FR);
}
const smooth = new Float64Array(nfr); // 60 ms moving average
for (let i = 0; i < nfr; i++) {
  let a = 0, n = 0;
  for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < nfr) { a += rms[j]; n++; } }
  smooth[i] = a / n;
}
const median = [...smooth].sort((a, b) => a - b)[Math.floor(nfr / 2)];

/** Split a span longer than MAX at the quietest point in [a+8s, a+MAX]. */
const forced: number[] = [];
function splitSpan(a: number, b: number): { start: number; end: number }[] {
  if (b - a <= MAX) return [{ start: a, end: b }];
  const lo = Math.round((a + 8) * 100);
  const hi = Math.min(Math.round((a + MAX) * 100), nfr - 1);
  let best = lo;
  for (let i = lo; i <= hi; i++) if (smooth[i] < smooth[best]) best = i;
  const c = best / 100;
  forced.push(c);
  return [{ start: a, end: c }, ...splitSpan(c, b)];
}
const refined = spans.flatMap((sp) => splitSpan(sp.start, sp.end));
const isForced = (x: number) => forced.some((c) => Math.abs(c - x) < 1e-6);

// greedy merge into chunks of <= MAX seconds, never merging across a forced cut
const chunks: { start: number; end: number }[] = [];
for (const s of refined) {
  const last = chunks.at(-1);
  if (last && !isForced(last.end) && s.end + PAD - last.start <= MAX) {
    last.end = isForced(s.end) ? s.end : s.end + PAD;
  } else {
    const startsAfterForced = last !== undefined && isForced(last.end);
    chunks.push({ start: startsAfterForced ? s.start : Math.max(0, s.start - PAD), end: isForced(s.end) ? s.end : s.end + PAD });
  }
}

const cut = (name: string, a: number, b: number) =>
  sh(["ffmpeg", "-v", "error", "-y", "-ss", String(a), "-t", String(b - a), "-i", wav, "-ar", "16000", "-ac", "1", name]);
const t = (x: number) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${(x % 60).toFixed(2).padStart(5, "0")}`;
const f = (x: number) => x.toFixed(2).replace(".", "_");

const rows: string[] = [];
let kept = 0;
for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i];
  const name = `kept_${String(i + 1).padStart(3, "0")}_${f(c.start)}-${f(c.end)}.wav`;
  await cut(`${out}/kept/${name}`, c.start, c.end);
  kept += c.end - c.start;
  const fc = forced.find((x) => Math.abs(x - c.end) < 1e-6);
  const note = fc === undefined ? "" : ` <b style="color:#b45309">ตัดกลางเสียงพูดต่อเนื่อง (พลังงาน ${((smooth[Math.round(fc * 100)] / median) * 100).toFixed(0)}% ของค่ากลาง)</b>`;
  rows.push(`<tr><td>${i + 1}</td><td>${t(c.start)} – ${t(c.end)}${note}</td><td>${(c.end - c.start).toFixed(1)}s</td><td><audio controls preload="none" src="kept/${name}"></audio></td></tr>`);
}

// whatever the chunks do not cover is what the VAD threw away
const gaps: { start: number; end: number }[] = [];
let cur = 0;
for (const c of chunks) {
  if (c.start - cur > 0.3) gaps.push({ start: cur, end: c.start });
  cur = c.end;
}
if (dur - cur > 0.3) gaps.push({ start: cur, end: dur });
const grows: string[] = [];
let dropped = 0;
for (let i = 0; i < gaps.length; i++) {
  const g = gaps[i];
  const name = `dropped_${String(i + 1).padStart(3, "0")}_${f(g.start)}-${f(g.end)}.wav`;
  await cut(`${out}/dropped/${name}`, g.start, g.end);
  dropped += g.end - g.start;
  grows.push(`<tr><td>${i + 1}</td><td>${t(g.start)} – ${t(g.end)}</td><td>${(g.end - g.start).toFixed(1)}s</td><td><audio controls preload="none" src="dropped/${name}"></audio></td></tr>`);
}

writeFileSync(
  `${out}/index.html`,
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VAD test</title><style>body{font:15px system-ui;margin:16px;max-width:980px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:4px 8px;text-align:left}audio{height:32px;width:300px}h2{margin-top:28px}</style>
<h1>VAD: ${src.split(/[\\/]/).pop()}</h1>
<p>ความยาวทั้งไฟล์ ${dur.toFixed(1)}s · ท่อนที่เก็บ ${chunks.length} ท่อน (${kept.toFixed(1)}s) · ช่วงที่ตัดทิ้ง ${gaps.length} ช่วง (${dropped.toFixed(1)}s) · ท่อนยาวสุด ${MAX}s · จุดที่ตัดเองกลางเสียงพูดต่อเนื่อง ${forced.length} จุด</p>
<p>ฟังท่อน <b>dropped</b> ว่ามีคำพูดหลุดไปไหม และฟังท่อน <b>kept</b> ว่าตัดกลางคำหรือไม่</p>
<h2>ท่อนที่เก็บไว้ (ส่งไปถอดเสียง)</h2><table><tr><th>#</th><th>ช่วงเวลา</th><th>ยาว</th><th>เสียง</th></tr>${rows.join("")}</table>
<h2>ช่วงที่ตัดทิ้ง (ไม่ส่งไปถอดเสียง)</h2><table><tr><th>#</th><th>ช่วงเวลา</th><th>ยาว</th><th>เสียง</th></tr>${grows.join("")}</table>`,
);

console.log(`file ${dur.toFixed(1)}s | VAD raw spans ${spans.length} | refined ${refined.length} | kept chunks ${chunks.length} (${kept.toFixed(1)}s) | dropped gaps ${gaps.length} (${dropped.toFixed(1)}s)`);
console.log("forced cuts (s):", forced.map((x) => x.toFixed(2)).join(", ") || "none");
console.log("chunk lengths  :", chunks.map((c) => (c.end - c.start).toFixed(1)).join(" "));
console.log("dropped gaps   :", gaps.map((g) => `${t(g.start)}(${(g.end - g.start).toFixed(1)}s)`).join(" "));
