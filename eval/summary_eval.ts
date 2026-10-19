// Evaluate the LLM summary against hand-written gold facts (eval/summary-gold.json).
//   For every gold file: run the app's real summarize pipeline on its transcript (in a separate temporary database,
//   so the app's own recordings are untouched), then score
//     recall    = gold facts covered by the summary / all gold facts
//     precision = summary items that cover at least one gold fact / all summary items
//   Coverage is decided by keyword groups (see the gold file) on each item's `text` (never on `quote`, which is copied
//   from the transcript). Baseline: the first K transcript lines, K = number of items the LLM produced.
// usage: bun eval/summary_eval.ts   (run from the repo root; needs the GPU and the transcripts in data/app.db; stop the app server first)
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { normRaw } from "./normalize";

const evalDb = resolve("data/eval/summary/eval.db");
mkdirSync(resolve("data/eval/summary"), { recursive: true });
rmSync(evalDb, { force: true });
rmSync(evalDb + "-wal", { force: true });
rmSync(evalDb + "-shm", { force: true });
process.env.DB_PATH = evalDb;
const { db, update, getRecording } = await import("../src/db");
const { tick } = await import("../src/worker");

interface Fact { id: string; fact: string; match: string[][] }
interface GoldFile { id: string; title: string; description: string; facts: Fact[] }
const gold: { files: GoldFile[] } = JSON.parse(await Bun.file(resolve("eval/summary-gold.json")).text());

// ---- load transcripts from the app database (read-only) and queue them in the eval database ----
const app = new Database(resolve("data/app.db"), { readonly: true });
const rowIds = new Map<string, number>();
const transcripts = new Map<string, { start: number; end: number; text: string }[]>();
for (const g of gold.files) {
  const row = app.query("SELECT transcript FROM recordings WHERE title = ? AND transcript IS NOT NULL ORDER BY id DESC").get(g.title) as { transcript: string } | null;
  if (!row) throw new Error(`transcript "${g.title}" not found in data/app.db`);
  transcripts.set(g.id, JSON.parse(row.transcript));
  const r = db.query("INSERT INTO recordings (title, status, transcript) VALUES (?, 'transcribed', ?) RETURNING id").get(g.title, row.transcript) as { id: number };
  rowIds.set(g.id, r.id);
}

const t0 = performance.now();
await tick(); // summarises every queued row, one at a time
const seconds = (performance.now() - t0) / 1000;

interface Item { text: string; quote: string; verified?: boolean }
interface Summary { overview: string; keywords: string[]; details: Item[]; highlights: Item[] }

const covers = (fact: Fact, itemText: string) => {
  const t = normRaw(itemText);
  return fact.match.some((group) => group.every((w) => t.includes(normRaw(w))));
};
function scoreItems(g: GoldFile, texts: string[], extra: string[] = []) {
  const covered = g.facts.filter((f) => [...texts, ...extra].some((t) => covers(f, t)));
  const useful = texts.filter((t) => g.facts.some((f) => covers(f, t)));
  const recall = covered.length / g.facts.length;
  const precision = texts.length ? useful.length / texts.length : NaN;
  const f1 = (2 * precision * recall) / (precision + recall);
  return { covered, recall, precision, f1: Number.isFinite(f1) ? f1 : 0, n: texts.length, useful: useful.length };
}
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");

const out: string[] = [];
out.push("# ผลวัดขั้นสรุป (LLM) เทียบเฉลยข้อเท็จจริง\n");
out.push(`สร้างโดย \`eval/summary_eval.ts\` เมื่อ ${new Date().toISOString()} · สรุป ${gold.files.length} ไฟล์ใช้เวลา ${seconds.toFixed(0)} วินาที\n`);
out.push("**ข้อควรระวัง:** เฉลย (`eval/summary-gold.json`) จดโดยผู้ช่วย AI จากบทถอดเสียง ไม่ใช่การจดอิสระของคน และการตัดสินว่ารายการสรุปครอบคลุมข้อเท็จจริงใช้กลุ่มคำ (keyword) ตรวจอัตโนมัติ มี 16 ข้อเท็จจริงรวมกัน ผลเป็นการทดสอบเบื้องต้น ตัวเลขแกว่งได้มาก\n");
out.push("- **Recall** = ข้อเท็จจริงในเฉลยที่สรุปครอบคลุม (ดูทั้งภาพรวม รายละเอียด และสิ่งที่น่าสนใจ)\n- **Precision** = รายการ (รายละเอียด + สิ่งที่น่าสนใจ) ที่ครอบคลุมข้อเท็จจริงในเฉลยอย่างน้อย 1 ข้อ ต่ำกว่าความจริงได้ เพราะรายการที่ถูกต้องแต่ไม่อยู่ในเฉลยนับเป็นผิด\n- **baseline** = เอา K บรรทัดแรกของบทถอดเสียงมาเป็นสรุป โดย K = จำนวนรายการที่ LLM ให้\n");

const rows: string[] = [];
const detail: string[] = [];
let tot = { llm: { c: 0, f: 0, u: 0, n: 0 }, base: { c: 0, f: 0, u: 0, n: 0 } };
const kwRows: string[] = [];
const runs: Record<string, unknown> = {};
for (const g of gold.files) {
  const rec = getRecording(rowIds.get(g.id)!)!;
  if (rec.status !== "done" || !rec.summary) {
    rows.push(`| ${g.description} | (สรุปล้มเหลว: ${rec.error ?? rec.status}) | | | | |`);
    continue;
  }
  const s: Summary = JSON.parse(rec.summary);
  runs[g.id] = s;
  const items = [...s.details, ...s.highlights];
  const llm = scoreItems(g, items.map((i) => i.text), [s.overview]);
  const k = Math.max(1, items.length);
  const baseTexts = transcripts.get(g.id)!.slice(0, k).map((x) => x.text);
  const base = scoreItems(g, baseTexts);
  for (const [t, m] of [["llm", llm], ["base", base]] as const) {
    tot[t].c += m.covered.length; tot[t].f += g.facts.length; tot[t].u += m.useful; tot[t].n += m.n;
  }
  rows.push(`| ${g.description} | ${g.facts.length} | LLM | ${f2(llm.precision)} (${llm.useful}/${llm.n}) | ${f2(llm.recall)} (${llm.covered.length}/${g.facts.length}) | ${f2(llm.f1)} |`);
  rows.push(`| | | baseline ${k} บรรทัดแรก | ${f2(base.precision)} (${base.useful}/${base.n}) | ${f2(base.recall)} (${base.covered.length}/${g.facts.length}) | ${f2(base.f1)} |`);
  const verified = items.filter((i) => i.verified).length;
  const text = normRaw(transcripts.get(g.id)!.map((x) => x.text).join(""));
  const kwFound = s.keywords.filter((w) => text.includes(normRaw(w)));
  kwRows.push(`| ${g.description} | ${verified}/${items.length} | ${kwFound.length}/${s.keywords.length} | ${s.keywords.join(", ")} |`);
  detail.push(`### ${g.description}\n\nภาพรวม: ${s.overview}\n\nKeywords: ${s.keywords.join(", ")}\n`);
  detail.push("รายละเอียดประกอบ:\n" + s.details.map((i) => `- ${i.verified ? "✓" : "✗"} ${i.text}`).join("\n") + "\n");
  detail.push("สิ่งที่น่าสนใจ:\n" + s.highlights.map((i) => `- ${i.verified ? "✓" : "✗"} ${i.text}`).join("\n") + "\n");
  detail.push("ข้อเท็จจริงที่ไม่ครอบคลุม: " + (g.facts.filter((f) => !llm.covered.includes(f)).map((f) => f.fact).join(" · ") || "(ไม่มี)") + "\n");
}
const micro = (t: { c: number; f: number; u: number; n: number }) => {
  const p = t.u / t.n;
  const r = t.c / t.f;
  return { p, r, f1: (2 * p * r) / (p + r), t };
};
const L = micro(tot.llm);
const B = micro(tot.base);
out.push("## ผลรวม (micro: รวมทุกไฟล์)\n");
out.push("| วิธี | Precision | Recall | F1 |\n|---|---|---|---|");
out.push(`| LLM (Typhoon 2.5 4B) | ${f2(L.p)} (${tot.llm.u}/${tot.llm.n}) | ${f2(L.r)} (${tot.llm.c}/${tot.llm.f}) | ${f2(L.f1)} |`);
out.push(`| baseline: บรรทัดแรกของบทถอดเสียง | ${f2(B.p)} (${tot.base.u}/${tot.base.n}) | ${f2(B.r)} (${tot.base.c}/${tot.base.f}) | ${f2(B.f1)} |\n`);
out.push("## แยกรายไฟล์\n");
out.push("| ไฟล์ | ข้อเท็จจริงในเฉลย | วิธี | Precision | Recall | F1 |\n|---|---|---|---|---|---|");
out.push(...rows);
out.push("\n## ตัวกันหลอนและ Keywords\n");
out.push("| ไฟล์ | รายการที่ตรวจพบในบทถอดเสียง | Keywords ที่พบคำนั้นในบทถอดเสียง | Keywords |\n|---|---|---|---|");
out.push(...kwRows);
out.push("\n(Keywords ที่ไม่พบในบทถอดเสียงอาจเป็นหัวข้อที่สรุปขึ้นเองอย่างสมเหตุสมผล ไม่จำเป็นต้องผิด)\n");
out.push("## ผลสรุปที่ได้จริง (ไว้ตรวจสอบ)\n");
out.push(...detail);
writeFileSync(resolve("eval/summary-results.md"), out.join("\n") + "\n");
writeFileSync(
  resolve("eval/summary-data.json"),
  JSON.stringify({ llm: { precision: L.p, recall: L.r, f1: L.f1 }, baseline: { precision: B.p, recall: B.r, f1: B.f1 }, facts: tot.llm.f }, null, 1) + "\n",
);
writeFileSync(resolve("data/eval/summary/runs.json"), JSON.stringify(runs, null, 1));
console.log(out.join("\n"));
process.exit(0);
