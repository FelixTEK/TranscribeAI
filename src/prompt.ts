export interface Segment {
  start: number; // seconds
  end: number;
  text: string;
}

export interface Item {
  text: string;
  quote: string;
  time?: number; // seconds, set by verify() from where the quote was found
  verified?: boolean;
}

export interface Summary {
  overview: string;
  keywords: string[]; // key terms / topics
  details: Item[]; // supporting facts: names, dates, times, numbers, decisions
  highlights: Item[]; // notable or important points
}

// ---- transcript cleanup -----------------------------------------------------

/**
 * Collapse a phrase repeated 4+ times in a row ("คอร์ดิชั่นนี้คือ" x100, "0.1 + 0.1 + ..."),
 * the typical Whisper loop hallucination, down to a single occurrence.
 */
export function collapseRepeats(text: string): string {
  return text.replace(/(.{2,30}?)(?:[\s,+\-]*\1){3,}/gu, "$1");
}

/**
 * Clean Whisper output: collapse in-segment loops, collapse identical consecutive segments,
 * and when two segments start at (almost) the same time keep the later one (Whisper's re-decode).
 */
export function cleanSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    const text = collapseRepeats(s.text.trim());
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && norm(prev.text) === norm(text)) {
      prev.end = s.end;
      continue;
    }
    if (prev && Math.abs(prev.start - s.start) < 0.5) {
      out[out.length - 1] = { start: prev.start, end: Math.max(prev.end, s.end), text };
      continue;
    }
    out.push({ start: s.start, end: s.end, text });
  }
  return out;
}

/** Sign-off phrases Whisper tends to invent at the end of a recording (learnt from subtitles of online videos). */
const TAIL_HALLUCINATIONS = [
  "感谢观看", "谢谢观看", "謝謝觀看", "请订阅", "ขอบคุณที่รับชม", "ขอบคุณที่ติดตามชม", "ขอบคุณที่รับชมครับ",
  "thanksforwatching", "thankyouforwatching", "pleasesubscribe", "subtitlesbytheamaraorgcommunity",
];

/**
 * Remove trailing segments that consist only of a known sign-off phrase. Only the end of the transcript is touched,
 * and a phrase that is part of a longer sentence is kept. Deliberately separate from cleanSegments so that the
 * evaluation scripts keep measuring raw model output.
 */
export function dropTailHallucinations(segments: Segment[]): Segment[] {
  const out = [...segments];
  const letters = (t: string) => t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  while (out.length) {
    const t = letters(out[out.length - 1].text);
    if (t && !TAIL_HALLUCINATIONS.some((p) => t === p)) break;
    out.pop();
  }
  return out;
}

export const fmtTime = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/** Split segments into chunks of at most `minutes` minutes of audio. */
export function chunkSegments(segments: Segment[], minutes: number): Segment[][] {
  const limit = minutes * 60;
  const chunks: Segment[][] = [];
  let cur: Segment[] = [];
  let origin = segments[0]?.start ?? 0;
  for (const s of segments) {
    if (cur.length && s.start - origin >= limit) {
      chunks.push(cur);
      cur = [];
      origin = s.start;
    }
    cur.push(s);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ---- prompts ----------------------------------------------------------------

const RULES = `กฎสำคัญ:
- ใช้เฉพาะข้อมูลที่อยู่ในบทถอดเสียงเท่านั้น ห้ามเดา ห้ามเติมเอง
- ทุกรายการใน details และ highlights ต้องมีฟิลด์ "quote" ซึ่งคัดลอกข้อความจากบทถอดเสียงมาตรงตัว (ไม่ต้องใส่เวลา [mm:ss]) ความยาวไม่เกิน 1 ประโยค
- บทถอดเสียงไม่มีป้ายบอกผู้พูด ถ้าจำเป็นให้ดูจากบริบทว่าใครเป็นคนพูด
- บทถอดเสียงมาจากระบบอัตโนมัติ อาจมีคำผิด ให้คงคำตามที่ปรากฏ
- ถ้าไม่มีข้อมูลในหมวดใดจริงๆ ให้ใส่อาร์เรย์ว่าง [] แต่ถ้ามีให้ดึงออกมาให้ครบทุกรายการ
- ตอบเป็นภาษาไทย และตอบเป็น JSON ตามรูปแบบที่กำหนดเท่านั้น`;

const EXAMPLE = `ตัวอย่างบทถอดเสียงสั้นๆ:
[00:00] วันนี้จะพูดถึงการวางแผนงบประมาณของโครงการปีหน้า
[00:06] ปีนี้เราใช้ไปแปดแสนบาท แต่ปีหน้าตั้งเป้าไว้หนึ่งล้านสองแสน
[00:13] ที่น่าสนใจคือค่าโฆษณาออนไลน์ถูกกว่าป้ายโฆษณาเกือบครึ่ง เลยจะย้ายงบไปทางนั้นก่อนสิ้นเดือนมีนาคม

ตัวอย่างผลลัพธ์:
{"overview":"พูดถึงแผนงบประมาณโครงการปีหน้า ซึ่งเพิ่มจากปีนี้ และจะย้ายงบโฆษณาไปทางออนไลน์","keywords":["งบประมาณ","โครงการปีหน้า","โฆษณาออนไลน์","ป้ายโฆษณา"],"details":[{"text":"งบปีนี้ที่ใช้ไป 800,000 บาท","quote":"ปีนี้เราใช้ไปแปดแสนบาท"},{"text":"เป้างบปีหน้า 1,200,000 บาท","quote":"ปีหน้าตั้งเป้าไว้หนึ่งล้านสองแสน"},{"text":"กำหนดย้ายงบก่อนสิ้นเดือนมีนาคม","quote":"ก่อนสิ้นเดือนมีนาคม"}],"highlights":[{"text":"โฆษณาออนไลน์ถูกกว่าป้ายโฆษณาเกือบครึ่ง จึงย้ายงบไปทางนั้น","quote":"ค่าโฆษณาออนไลน์ถูกกว่าป้ายโฆษณาเกือบครึ่ง"}]}`;

export function buildChunkPrompt(chunk: Segment[]): string {
  const lines = chunk.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join("\n");
  return `คุณเป็นผู้ช่วยสรุปเนื้อหาจากบทถอดเสียงของการบันทึกเสียง ซึ่งอาจเป็นบทสนทนา การบรรยาย การประชุม หรือการเล่าเรื่อง ให้สรุปให้เป็นประโยชน์กับคนที่ไม่ได้ฟังเสียงเอง

หมวดที่ต้องดึงออกมา:
- overview: สรุปภาพรวมสั้นๆ 2-3 ประโยค ว่าพูดถึงเรื่องอะไร
- keywords: คำสำคัญหรือหัวข้อหลัก 3-10 คำ เป็นคำหรือวลีสั้นๆ ที่ตรงกับเนื้อหาจริง
- details: รายละเอียดประกอบที่เป็นข้อเท็จจริง เช่น ชื่อคนหรือสถานที่ วันที่ เวลา ตัวเลข จำนวนเงิน ข้อตกลง การตัดสินใจ สิ่งที่ต้องทำ
- highlights: สิ่งที่น่าสนใจหรือสำคัญที่สุดในบันทึก เช่น ข้อสังเกต ข้อสรุป ประเด็นที่ขัดความคาดหมาย

${RULES}

${EXAMPLE}

บทถอดเสียงจริงที่ต้องสรุป:
${lines}
`;
}

export function buildOverviewPrompt(overviews: string[]): string {
  return `ด้านล่างเป็นสรุปย่อยของแต่ละช่วงของการบันทึกเสียงเดียวกัน จงรวมเป็นสรุปภาพรวมเดียว 3-5 ประโยค
ใช้เฉพาะข้อมูลที่มีในสรุปย่อยเท่านั้น ห้ามเดา และห้ามอ้างถึงหมายเลขช่วง ให้เขียนเป็นเรื่องเดียวต่อเนื่องในย่อหน้าเดียว

${overviews.map((o, i) => `ช่วงที่ ${i + 1}: ${o}`).join("\n")}
`;
}

const itemSchema = {
  type: "object",
  properties: { text: { type: "string", maxLength: 200 }, quote: { type: "string", maxLength: 200 } },
  required: ["text", "quote"],
};
// maxItems keeps a small model from looping on the same entry until it runs out of tokens
const list = { type: "array", items: itemSchema, maxItems: 8 };

export const chunkSchema = {
  type: "object",
  properties: {
    overview: { type: "string", maxLength: 500 },
    keywords: { type: "array", items: { type: "string", maxLength: 60 }, maxItems: 10 },
    details: list,
    highlights: list,
  },
  required: ["overview", "keywords", "details", "highlights"],
};

export const overviewSchema = {
  type: "object",
  properties: { overview: { type: "string" } },
  required: ["overview"],
};

// ---- hallucination guard: check quotes against the transcript ----------------

/** Lowercase and strip whitespace/punctuation (Thai has no spaces, Whisper spacing is arbitrary). */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Mark each item verified when its quote occurs in the transcript, and set `time`
 * to the start of the segment where it was found. Quotes that are not found exactly
 * are accepted only if most of their 4-char shingles appear in the transcript.
 */
export function verify(items: Item[], segments: Segment[], threshold = 0.85): Item[] {
  let full = "";
  const owner: number[] = []; // normalized char index -> segment index
  segments.forEach((s, i) => {
    const n = norm(s.text);
    for (let k = 0; k < n.length; k++) owner.push(i);
    full += n;
  });

  return items.map((it) => {
    const q = norm(it.quote ?? "");
    if (q.length < 4) return { ...it, verified: false };
    const at = full.indexOf(q);
    if (at >= 0) return { ...it, verified: true, time: segments[owner[at]].start };

    let hit = 0;
    const total = q.length - 3;
    for (let i = 0; i < total; i++) if (full.includes(q.slice(i, i + 4))) hit++;
    const verified = hit / total >= threshold;
    return { ...it, verified };
  });
}

/** Wrap a user prompt in the ChatML template used by Qwen3 / Typhoon 2.5 (llama-completion does not apply it). */
export const chatml = (user: string) => `<|im_start|>user
${user}<|im_end|>
<|im_start|>assistant
`;

/** Drop items that repeat an earlier quote (chunk overlap / model looping). */
export function dedupe(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const k = norm(it.quote ?? "") || norm(it.text ?? "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
