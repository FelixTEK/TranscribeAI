// Step 3 of docs/vad-test-plan.md: run every config on L1 and L2, save raw segments + time + peak VRAM.
// usage: bun data/eval/run_long.ts [config ids comma separated] [file labels comma separated]
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cutChunks, planChunks, type ChunkConfig } from "../src/chunker";
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
const outDir = `${root}/data/eval/long/results`;
mkdirSync(outDir, { recursive: true });

interface Config {
  id: string;
  model: keyof typeof MODELS;
  mode: "whole" | "whole-vad" | "chunked" | "chunked-keep";
}
const CONFIGS: Config[] = [
  { id: "C1", model: "typhoon", mode: "whole" },
  { id: "C2", model: "typhoon", mode: "whole-vad" },
  { id: "C3", model: "typhoon", mode: "chunked" },
  { id: "C3k", model: "typhoon", mode: "chunked-keep" },
  { id: "C4", model: "turbo", mode: "whole" },
  { id: "C5", model: "turbo", mode: "whole-vad" },
];
const wantCfg = process.argv[2]?.split(",");
const wantFile = process.argv[3]?.split(",") ?? ["L1", "L2"];

// ---- VRAM sampler (nvidia-smi once a second) ----
let peak = 0;
let sampling: ReturnType<typeof setInterval> | undefined;
const vram = async () => {
  const p = Bun.spawn(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], { stdout: "pipe" });
  return Number((await new Response(p.stdout).text()).trim());
};
const startSampling = () => {
  peak = 0;
  sampling = setInterval(async () => {
    peak = Math.max(peak, await vram().catch(() => 0));
  }, 1000);
};
const stopSampling = () => clearInterval(sampling);

const log = (s: string) => {
  const line = `[${new Date().toLocaleTimeString("en-GB")}] ${s}`;
  console.log(line);
  Bun.write(Bun.file(`${outDir}/run.log`), line + "\n").catch(() => {});
};
let logBuf = "";
const logf = (s: string) => {
  const line = `[${new Date().toLocaleTimeString("en-GB")}] ${s}`;
  console.log(line);
  logBuf += line + "\n";
  writeFileSync(`${outDir}/run.log`, logBuf);
};

for (const label of wantFile) {
  const wav = `${root}/data/eval/long/${label}.wav`;
  for (const c of CONFIGS) {
    if (wantCfg && !wantCfg.includes(c.id)) continue;
    const resultPath = `${outDir}/${label}_${c.id}.json`;
    if (existsSync(resultPath)) {
      logf(`skip ${label} ${c.id} (exists)`);
      continue;
    }
    const baseline = await vram();
    logf(`start ${label} ${c.id} (${c.model}, ${c.mode}), baseline VRAM ${baseline} MiB`);
    startSampling();
    const t0 = performance.now();
    let segments: Segment[] = [];
    let extra: Record<string, unknown> = {};
    try {
      if (c.mode === "whole" || c.mode === "whole-vad") {
        const base = `${root}/data/eval/long/tmp_${label}_${c.id}`;
        const args = [WHISPER, "-m", MODELS[c.model], "-f", wav, "-l", "th", "-mc", "0", "-np", "-oj", "-of", base];
        if (c.mode === "whole-vad") args.push("--vad", "--vad-model", VAD);
        await run(args);
        segments = parseWhisperJson(await Bun.file(`${base}.json`).arrayBuffer(), 0);
        rmSync(`${base}.json`, { force: true });
      } else {
        const cc: ChunkConfig = {
          ffmpeg: "ffmpeg", vadBin: `${root}/bin/whisper/Release/whisper-vad-speech-segments.exe`, vadModel: VAD,
          maxSeconds: 25, dropSilenceSeconds: 2, keepSilence: c.mode === "chunked-keep",
        };
        const plan = await planChunks(wav, cc);
        const dir = `${root}/data/eval/long/tmp_${label}_${c.id}`;
        const files = await cutChunks(wav, plan.chunks, dir, "ffmpeg");
        await transcribeFiles({ whisper: WHISPER, model: MODELS[c.model], files });
        for (let i = 0; i < files.length; i++) {
          const segs = parseWhisperJson(await Bun.file(`${files[i]}.json`).arrayBuffer(), plan.chunks[i].start);
          if (segs.length === 1) {
            segs[0].start = plan.chunks[i].start;
            segs[0].end = plan.chunks[i].end;
          }
          segments.push(...segs.map((s) => ({ ...s, kind: plan.chunks[i].kind }) as Segment));
        }
        rmSync(dir, { recursive: true, force: true });
        extra = {
          chunks: plan.chunks.length,
          speechChunks: plan.chunks.filter((x) => x.kind === "speech").length,
          silenceChunks: plan.chunks.filter((x) => x.kind === "silence").length,
          forcedCuts: plan.forcedCuts,
          chunkSecondsTotal: plan.chunks.reduce((n, x) => n + (x.end - x.start), 0),
        };
      }
    } catch (e) {
      stopSampling();
      logf(`FAILED ${label} ${c.id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    stopSampling();
    const seconds = (performance.now() - t0) / 1000;
    writeFileSync(
      resultPath,
      JSON.stringify({ label, config: c, seconds: Number(seconds.toFixed(1)), peakVramMiB: peak, baselineVramMiB: baseline, ...extra, segments }, null, 1),
    );
    logf(`done ${label} ${c.id}: ${seconds.toFixed(0)} s, peak VRAM ${peak} MiB, ${segments.length} segments`);
  }
}
logf("ALL DONE");
