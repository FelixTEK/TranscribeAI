import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "./proc";

export interface Span {
  start: number;
  end: number;
}

export interface Chunk extends Span {
  kind: "speech" | "silence";
}

export interface ChunkConfig {
  ffmpeg: string;
  vadBin: string; // whisper-vad-speech-segments
  vadModel: string;
  /** longest chunk we hand to Whisper (a 30 s window is its limit) */
  maxSeconds: number;
  /** VAD gaps at least this long end a chunk (they are not mixed into speech) */
  dropSilenceSeconds: number;
  /** also emit the long silences as chunks of their own (to see what Whisper makes of them) */
  keepSilence: boolean;
  padSeconds?: number;
}

export interface Plan {
  chunks: Chunk[];
  speech: Span[]; // raw VAD output, before splitting
  forcedCuts: number[]; // cuts made inside continuous speech at the quietest point
  duration: number;
  envMedian: number;
  /** smoothed energy at a time (seconds), for diagnostics */
  energyAt: (t: number) => number;
}

const FR = 160; // 10 ms at 16 kHz

/** Speech spans (seconds) from the Silero VAD. `-vmsd` does nothing in this tool, so long spans are split later. */
async function vadSpans(wav: string, cfg: ChunkConfig): Promise<Span[]> {
  const { out } = await run([cfg.vadBin, "-f", wav, "-vm", cfg.vadModel, "-np"]);
  // "Speech segment 3: start = 1037.00, end = 1101.00" (centiseconds)
  return [...out.matchAll(/start = ([\d.]+), end = ([\d.]+)/g)].map((m) => ({
    start: Number(m[1]) / 100,
    end: Number(m[2]) / 100,
  }));
}

/** Energy per 10 ms frame, smoothed over 60 ms. Streams ffmpeg's PCM so long files stay cheap. */
async function energyEnvelope(wav: string, ffmpeg: string): Promise<Float64Array> {
  const proc = Bun.spawn([ffmpeg, "-v", "error", "-i", wav, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const rms: number[] = [];
  let carry = Buffer.alloc(0);
  for await (const c of proc.stdout) {
    let buf = carry.length ? Buffer.concat([carry, c]) : Buffer.from(c);
    const bytesPerFrame = FR * 2;
    const frames = Math.floor(buf.length / bytesPerFrame);
    for (let f = 0; f < frames; f++) {
      let a = 0;
      for (let k = 0; k < FR; k++) {
        const v = buf.readInt16LE(f * bytesPerFrame + k * 2);
        a += v * v;
      }
      rms.push(Math.sqrt(a / FR));
    }
    carry = buf.subarray(frames * bytesPerFrame);
  }
  await proc.exited;
  const n = rms.length;
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    let m = 0;
    for (let k = -3; k <= 3; k++) {
      const j = i + k;
      if (j >= 0 && j < n) {
        a += rms[j];
        m++;
      }
    }
    smooth[i] = a / m;
  }
  return smooth;
}

/** Split a span longer than `max` at the quietest point in [a + minPiece, a + max], repeatedly. */
function splitLong(a: number, b: number, env: Float64Array, max: number, forced: number[], minPiece = 8): Span[] {
  if (b - a <= max) return [{ start: a, end: b }];
  const lo = Math.round((a + minPiece) * 100);
  const hi = Math.min(Math.round((a + max) * 100), env.length - 1);
  let best = lo;
  for (let i = lo; i <= hi; i++) if (env[i] < env[best]) best = i;
  const c = best / 100;
  forced.push(c);
  return [{ start: a, end: c }, ...splitLong(c, b, env, max, forced, minPiece)];
}

/**
 * Greedy merge of speech spans into chunks of at most `max` seconds. A chunk ends at a VAD gap of
 * `dropSilenceSeconds` or more, at a forced cut, or when the next span would not fit. Edges get a small pad.
 */
export function mergeSpans(spans: Span[], forced: number[], duration: number, cfg: ChunkConfig): Chunk[] {
  const pad = cfg.padSeconds ?? 0.15;
  const isForced = (x: number) => forced.some((c) => Math.abs(c - x) < 1e-6);
  const chunks: Chunk[] = [];
  let lastSpanEnd = -Infinity;
  for (const s of spans) {
    const last = chunks.at(-1);
    const gap = s.start - lastSpanEnd;
    const endAtForced = isForced(s.end);
    if (last && !isForced(lastSpanEnd) && gap < cfg.dropSilenceSeconds && s.end + pad - last.start <= cfg.maxSeconds) {
      last.end = endAtForced ? s.end : Math.min(duration, s.end + pad);
    } else {
      const afterForced = last !== undefined && isForced(lastSpanEnd);
      let start = afterForced ? s.start : Math.max(0, s.start - pad);
      if (last && start < last.end) {
        // neighbouring chunks would overlap: cut in the middle of the gap instead
        const mid = (last.end + start) / 2;
        last.end = mid;
        start = mid;
      }
      chunks.push({ start, end: endAtForced ? s.end : Math.min(duration, s.end + pad), kind: "speech" });
    }
    lastSpanEnd = s.end;
  }
  return chunks;
}

/** Fill the uncovered regions (>= minGap seconds) with silence chunks of at most `max` seconds. */
export function silenceChunks(speech: Chunk[], duration: number, max: number, minGap = 0.3): Chunk[] {
  const out: Chunk[] = [];
  const gaps: Span[] = [];
  let cur = 0;
  for (const c of speech) {
    if (c.start - cur >= minGap) gaps.push({ start: cur, end: c.start });
    cur = c.end;
  }
  if (duration - cur >= minGap) gaps.push({ start: cur, end: duration });
  for (const g of gaps) {
    const n = Math.ceil((g.end - g.start) / max);
    const len = (g.end - g.start) / n;
    for (let i = 0; i < n; i++) out.push({ start: g.start + i * len, end: g.start + (i + 1) * len, kind: "silence" });
  }
  return out;
}

export async function planChunks(wav: string, cfg: ChunkConfig): Promise<Plan> {
  const [speech, env] = await Promise.all([vadSpans(wav, cfg), energyEnvelope(wav, cfg.ffmpeg)]);
  const duration = env.length / 100;
  const forced: number[] = [];
  const refined = speech.flatMap((s) => splitLong(s.start, s.end, env, cfg.maxSeconds, forced));
  const chunks: Chunk[] = mergeSpans(refined, forced, duration, cfg);
  if (cfg.keepSilence) chunks.push(...silenceChunks(chunks, duration, cfg.maxSeconds));
  chunks.sort((a, b) => a.start - b.start);
  const median = [...env].sort((a, b) => a - b)[Math.floor(env.length / 2)] ?? 0;
  return {
    chunks,
    speech,
    forcedCuts: forced,
    duration,
    envMedian: median,
    energyAt: (t) => env[Math.min(env.length - 1, Math.max(0, Math.round(t * 100)))] ?? 0,
  };
}

/** Cut every chunk out of `wav` into `dir` (c00000.wav ...). Returns the file paths in chunk order. */
export async function cutChunks(wav: string, chunks: Span[], dir: string, ffmpeg: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const f = resolve(dir, `c${String(i).padStart(5, "0")}.wav`);
    await run([
      ffmpeg, "-v", "error", "-y", "-ss", String(chunks[i].start), "-t", String(chunks[i].end - chunks[i].start),
      "-i", wav, "-ar", "16000", "-ac", "1", f,
    ]);
    files.push(f);
  }
  return files;
}
