import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cutChunks, planChunks, type ChunkConfig } from "./chunker";
import { getRecording, nextWithStatus, update } from "./db";
import { rm, run } from "./proc";
import {
  buildChunkPrompt,
  buildOverviewPrompt,
  chatml,
  chunkSchema,
  chunkSegments,
  dedupe,
  cleanSegments,
  dropTailHallucinations,
  overviewSchema,
  verify,
  type Item,
  type Segment,
  type Summary,
} from "./prompt";
import { parseWhisperJson, transcribeFiles } from "./whisper";

const env = (k: string, d: string) => Bun.env[k] || d;
const path = (k: string, d: string) => resolve(env(k, d));

export const cfg = {
  ffmpeg: env("FFMPEG", "ffmpeg"),
  whisper: path("WHISPER_CLI", "bin/whisper/Release/whisper-cli.exe"),
  whisperModel: path("WHISPER_MODEL", "models/ggml-typhoon-large-v3-q8_0.bin"),
  vadModel: path("VAD_MODEL", "models/ggml-silero-v6.2.0.bin"),
  vadSegments: path("VAD_SEGMENTS_BIN", "bin/whisper/Release/whisper-vad-speech-segments.exe"),
  // "chunked": cut the audio at pauses and transcribe each piece (for models without timestamp tokens, e.g. Typhoon Whisper)
  // "direct": one whisper-cli pass over the whole file, no VAD (models with timestamps, e.g. turbo)
  whisperMode: env("WHISPER_MODE", "chunked"),
  lang: env("WHISPER_LANG", "th"), // th | en | zh | ... | auto
  chunkSeconds: Number(env("CHUNK_SECONDS", "25")),
  dropSilenceSeconds: Number(env("DROP_SILENCE_SECONDS", "2")),
  keepSilence: env("KEEP_SILENCE", "false") === "true",
  llama: path("LLAMA_BIN", "bin/llama/llama-completion.exe"),
  llmModel: path("LLM_MODEL", "models/typhoon2.5-qwen3-4b-q4_k_m.gguf"),
  ctx: env("LLM_CTX", "8192"),
  temp: env("LLM_TEMP", "0.2"),
  chunkMinutes: Number(env("CHUNK_MINUTES", "8")),
  tmpDir: path("TMP_DIR", "data/tmp"),
  keepAudioDays: Number(env("KEEP_AUDIO_DAYS", "0")),
};

export const chunkConfig: ChunkConfig = {
  ffmpeg: cfg.ffmpeg,
  vadBin: cfg.vadSegments,
  vadModel: cfg.vadModel,
  maxSeconds: cfg.chunkSeconds,
  dropSilenceSeconds: cfg.dropSilenceSeconds,
  keepSilence: cfg.keepSilence,
};

mkdirSync(cfg.tmpDir, { recursive: true });

export const audioPath = (id: number) => resolve(cfg.tmpDir, `${id}.audio`);

// ---- stage 1: ffmpeg + whisper ---------------------------------------------

/**
 * Typhoon Whisper emits no timestamp tokens, so whisper.cpp returns one 30 s block per window and may cut
 * it mid-word. Cutting at pauses first gives pieces whose start time we know exactly.
 */
async function transcribeChunked(id: number, wav: string): Promise<Segment[]> {
  const dir = resolve(cfg.tmpDir, `${id}.chunks`);
  const plan = await planChunks(wav, chunkConfig);
  if (!plan.chunks.length) return [];
  const files = await cutChunks(wav, plan.chunks, dir, cfg.ffmpeg);
  await transcribeFiles({
    whisper: cfg.whisper,
    model: cfg.whisperModel,
    lang: cfg.lang,
    files,
    onProgress: (done, total) => update(id, { progress: Math.min(99, Math.round((done / total) * 100)) }),
  });

  const out: Segment[] = [];
  for (let i = 0; i < files.length; i++) {
    const segs = parseWhisperJson(await Bun.file(`${files[i]}.json`).arrayBuffer(), plan.chunks[i].start);
    // one block per chunk when there are no timestamps: pin it to the chunk's real span
    if (segs.length === 1) {
      segs[0].start = plan.chunks[i].start;
      segs[0].end = plan.chunks[i].end;
    }
    out.push(...segs);
  }
  return out;
}

async function transcribe(id: number) {
  const src = audioPath(id);
  const wav = resolve(cfg.tmpDir, `${id}.wav`);
  const base = resolve(cfg.tmpDir, `${id}`);
  try {
    update(id, { status: "transcribing", progress: 0, error: null });
    await run([cfg.ffmpeg, "-v", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", wav]);

    let raw: Segment[];
    if (cfg.whisperMode === "chunked") {
      raw = await transcribeChunked(id, wav);
    } else {
      await run(
        [
          cfg.whisper, "-m", cfg.whisperModel, "-f", wav, "-l", cfg.lang, "-mc", "0", "-pp", "-oj", "-of", base,
        ],
        (s) => {
          const m = [...s.matchAll(/progress =\s*(\d+)%/g)].pop();
          if (m) update(id, { progress: Number(m[1]) });
        },
      );
      raw = parseWhisperJson(await Bun.file(`${base}.json`).arrayBuffer(), 0);
    }

    const segments = dropTailHallucinations(cleanSegments(raw));
    update(id, { status: "transcribed", progress: 0, transcript: JSON.stringify(segments) });
  } finally {
    // the audio is never kept longer than needed
    rm(wav, `${base}.json`);
    rmSync(resolve(cfg.tmpDir, `${id}.chunks`), { recursive: true, force: true });
    if (cfg.keepAudioDays <= 0) rm(src);
  }
}

// ---- stage 2: llama.cpp -----------------------------------------------------

async function askLlm(id: number, tag: string, prompt: string, schema: object, maxTokens: number): Promise<any> {
  const pFile = resolve(cfg.tmpDir, `${id}.${tag}.prompt.txt`);
  const sFile = resolve(cfg.tmpDir, `${id}.${tag}.schema.json`);
  try {
    writeFileSync(pFile, chatml(prompt), "utf8");
    writeFileSync(sFile, JSON.stringify(schema), "utf8");
    const { out } = await run([
      cfg.llama, "-m", cfg.llmModel, "-f", pFile, "-jf", sFile,
      "-c", cfg.ctx, "-n", String(maxTokens), "--repeat-penalty", "1.05", "-ngl", "99", "-fa", "on",
      "-ctk", "q8_0", "-ctv", "q8_0", "--temp", cfg.temp,
      "-no-cnv", "--no-display-prompt", "--simple-io", "--no-warmup",
    ]);
    const a = out.indexOf("{");
    const b = out.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error(`LLM returned no JSON: ${out.slice(-300)}`);
    return JSON.parse(out.slice(a, b + 1));
  } finally {
    rm(pFile, sFile);
  }
}

async function summarize(id: number) {
  const rec = getRecording(id)!;
  const segments: Segment[] = JSON.parse(rec.transcript ?? "[]");
  update(id, { status: "summarizing", progress: 0, error: null });

  if (!segments.length) {
    const empty: Summary = { overview: "ไม่พบเสียงพูดในไฟล์นี้", keywords: [], details: [], highlights: [] };
    update(id, { status: "done", progress: 100, summary: JSON.stringify(empty) });
    return;
  }

  const chunks = chunkSegments(segments, cfg.chunkMinutes);
  const overviews: string[] = [];
  const keywords: string[] = [];
  const merged = { details: [] as Item[], highlights: [] as Item[] };

  for (let i = 0; i < chunks.length; i++) {
    const r = await askLlm(id, `c${i}`, buildChunkPrompt(chunks[i]), chunkSchema, 2500);
    overviews.push(String(r.overview ?? ""));
    keywords.push(...((r.keywords ?? []) as unknown[]).map((k) => String(k).trim()).filter(Boolean));
    merged.details.push(...((r.details ?? []) as Item[]));
    merged.highlights.push(...((r.highlights ?? []) as Item[]));
    update(id, { progress: Math.round(((i + 1) / chunks.length) * 90) });
  }

  let overview = overviews[0] ?? "";
  if (overviews.length > 1) {
    const r = await askLlm(id, "ov", buildOverviewPrompt(overviews), overviewSchema, 500);
    overview = String(r.overview ?? overviews.join(" "));
  }

  const summary: Summary = {
    overview,
    keywords: [...new Map(keywords.map((k) => [k.toLowerCase(), k])).values()].slice(0, 15),
    details: verify(dedupe(merged.details), segments),
    highlights: verify(dedupe(merged.highlights), segments),
  };
  update(id, { status: "done", progress: 100, summary: JSON.stringify(summary) });
}

// ---- queue loop --------------------------------------------------------------

let running = false;

/** Two rounds so Whisper and the LLM never share the GPU: all transcriptions first, then all summaries. */
export async function tick() {
  if (running) return;
  running = true;
  try {
    for (let job; (job = nextWithStatus("queued")); ) {
      try {
        await transcribe(job.id);
      } catch (e) {
        update(job.id, { status: "failed", error: String(e instanceof Error ? e.message : e) });
      }
    }
    for (let job; (job = nextWithStatus("transcribed")); ) {
      try {
        await summarize(job.id);
      } catch (e) {
        update(job.id, { status: "failed", error: String(e instanceof Error ? e.message : e) });
      }
    }
  } finally {
    running = false;
  }
}

/** Delete kept audio older than KEEP_AUDIO_DAYS (only relevant if that is > 0). */
function purgeOldAudio() {
  if (cfg.keepAudioDays <= 0 || !existsSync(cfg.tmpDir)) return;
  const cutoff = Date.now() - cfg.keepAudioDays * 86_400_000;
  for (const f of readdirSync(cfg.tmpDir)) {
    const p = resolve(cfg.tmpDir, f);
    if (statSync(p).mtimeMs < cutoff) rm(p);
  }
}

export function startWorker() {
  purgeOldAudio();
  setInterval(() => void tick(), 3000);
  void tick();
}
