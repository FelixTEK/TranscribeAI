import { run } from "./proc";
import type { Segment } from "./prompt";

/**
 * Parse a whisper-cli JSON file. whisper.cpp can cut a segment in the middle of a multi-byte UTF-8
 * character (it happens when a model emits no timestamps), so the file may not be valid UTF-8 as a whole.
 * Read it as latin1 (the JSON structure is ASCII), then decode each segment's bytes with a streaming decoder
 * so a split character is stitched back together.
 */
export function parseWhisperJson(buf: ArrayBuffer, offsetSec = 0): Segment[] {
  const json = JSON.parse(Buffer.from(buf).toString("latin1"));
  const dec = new TextDecoder("utf-8");
  const out: Segment[] = [];
  for (const t of json.transcription as any[]) {
    // an orphan byte left by a split character decodes to U+FFFD: that character is lost, drop the marker
    const text = dec.decode(Buffer.from(t.text, "latin1"), { stream: true }).replace(/�/g, "");
    out.push({ start: offsetSec + t.offsets.from / 1000, end: offsetSec + t.offsets.to / 1000, text });
  }
  return out;
}

/**
 * Transcribe many short wav files. One whisper-cli process per batch so the model is loaded once per batch
 * (and the command line stays short). Writes `<file>.json` next to every input.
 */
export async function transcribeFiles(opts: {
  whisper: string;
  model: string;
  files: string[];
  /** whisper language code: "th", "en", "zh", ... or "auto" to let the model detect it */
  lang?: string;
  extraArgs?: string[];
  batch?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<void> {
  const batch = opts.batch ?? 60;
  let done = 0;
  for (let b = 0; b < opts.files.length; b += batch) {
    const files = opts.files.slice(b, b + batch);
    await run(
      [opts.whisper, "-m", opts.model, "-l", opts.lang ?? "th", "-mc", "0", "-np", "-oj", ...(opts.extraArgs ?? []), ...files],
      (s) => {
        done += (s.match(/output_json: saving output/g) ?? []).length;
        opts.onProgress?.(Math.min(done, opts.files.length), opts.files.length);
      },
    );
  }
}
