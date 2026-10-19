// Evaluate `verify()` (src/prompt.ts) as a binary classifier: does a quote the LLM returned really come from the transcript?
// Positive class = "fabricated quote" (what the checker is meant to catch).
//   TP: fabricated quote flagged unverified   FN: fabricated quote accepted
//   FP: faithful quote flagged unverified     TN: faithful quote accepted
// Cases are generated from real transcripts with a fixed seed (no GPU, no people needed).
// usage: bun eval/verify_eval.ts   (run from the repo root; writes eval/verify-results.md)
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { verify, type Item, type Segment } from "../src/prompt";

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(99);
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];

// ---- corpora: transcripts with known content --------------------------------
interface Corpus {
  name: string;
  lang: "th" | "en";
  segs: Segment[];
}
const corpora: Corpus[] = [];
const dbPath = resolve("data/app.db");
if (existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true });
  for (const [title, lang, name] of [["WB-IMF (สรุปรูปแบบใหม่)", "th", "ข่าวไทย (ช่อง 9)"], ["NBTEng", "en", "ข่าวอังกฤษ"]] as const) {
    const row = db.query("SELECT transcript FROM recordings WHERE title = ? AND transcript IS NOT NULL").get(title) as { transcript: string } | null;
    if (row) corpora.push({ name, lang, segs: JSON.parse(row.transcript) });
  }
}
const l1 = resolve("data/eval/long/results/L1_C3.json");
if (existsSync(l1)) corpora.push({ name: "FLEURS ต่อกัน (L1, Typhoon)", lang: "th", segs: JSON.parse(await Bun.file(l1).text()).segments });
if (corpora.length < 2) throw new Error("need at least two transcripts (app database / eval results not found)");

const FABRICATED: Record<"th" | "en", string[]> = {
  th: [
    "ผมจะโอนเงินให้ภายในวันศุกร์หน้าเลยครับ", "ที่ประชุมมีมติเห็นชอบให้ปรับขึ้นราคาสินค้าร้อยละสิบ", "อย่าลืมซื้อทุเรียนที่จตุจักรมาฝากด้วยนะ",
    "คณะกรรมการจะประกาศผลการสอบในเดือนหน้า", "เราตกลงกันว่าจะนัดพบกันที่สนามบินตอนเช้า", "ระบบจะปิดปรับปรุงตั้งแต่เที่ยงคืนถึงตีสาม",
    "ค่าใช้จ่ายทั้งหมดรวมแล้วประมาณหนึ่งแสนห้าหมื่นบาท", "พรุ่งนี้ช่วยพาน้องไปหาหมอตอนบ่ายสองโมงด้วย",
  ],
  en: [
    "We will transfer the money by next Friday", "The committee voted to raise prices by ten percent", "Please remember to bring the documents tomorrow morning",
    "The results will be announced next month", "They agreed to meet at the airport early in the morning", "The system will be down for maintenance after midnight",
    "The total cost comes to around fifty thousand dollars", "Take your brother to the doctor at two in the afternoon",
  ],
};

const RANDOM_CHARS = {
  th: Array.from("กขคงจชซดตถทนบปผพฟมยรลวสหอฮะาิีึืุูเแโใไ"),
  en: Array.from("abcdefghijklmnopqrstuvwxyz"),
};

type Kind = "pos_exact" | "pos_filler" | "pos_span" | "pos_typo" | "neg_other" | "neg_mixed" | "neg_fabricated" | "neg_splice";
const KIND_INFO: Record<Kind, { fab: boolean; label: string }> = {
  pos_exact: { fab: false, label: "ของจริง: คัดลอกตรงตัว" },
  pos_filler: { fab: false, label: "ของจริง: ต่อท้ายคำเสริม (นะครับ / you know)" },
  pos_span: { fab: false, label: "ของจริง: ข้าม 2 segment ติดกัน" },
  pos_typo: { fab: false, label: "ของจริง: สะกดเพี้ยน ~5% (LLM ปรับตัวสะกด)" },
  neg_other: { fab: true, label: "ของปลอม: ประโยคจากไฟล์อื่น" },
  neg_mixed: { fab: true, label: "ของปลอม: ของจริงที่เปลี่ยนตรงกลาง ~35%" },
  neg_fabricated: { fab: true, label: "ของปลอม: ประโยคแต่งขึ้นใหม่" },
  neg_splice: { fab: true, label: "ของปลอม: ต่อครึ่งประโยคจาก 2 ที่ห่างกัน" },
};

const usable = (c: Corpus) => c.segs.map((s, i) => ({ s, i })).filter(({ s }) => Array.from(s.text.trim()).length >= 14);
const chars = (t: string) => Array.from(t.trim());

function makeCases(c: Corpus, perKind: number) {
  const segs = usable(c);
  const cases: { kind: Kind; quote: string; orig?: string }[] = [];
  for (let n = 0; n < perKind; n++) {
    const first = cases.length;
    const { s, i } = pick(segs);
    const text = s.text.trim();
    cases.push({ kind: "pos_exact", quote: text });
    cases.push({ kind: "pos_filler", quote: text + (c.lang === "th" ? " นะครับ" : " you know") });
    const next = c.segs[i + 1]?.text.trim() ?? "";
    cases.push({ kind: "pos_span", quote: next ? text + " " + next : text });
    const a = chars(text);
    for (let k = 0; k < Math.max(1, Math.round(a.length * 0.05)); k++) a[Math.floor(rand() * a.length)] = pick(RANDOM_CHARS[c.lang]);
    cases.push({ kind: "pos_typo", quote: a.join("") });

    const other = pick(corpora.filter((o) => o !== c && o.lang === c.lang).length ? corpora.filter((o) => o !== c && o.lang === c.lang) : corpora.filter((o) => o !== c));
    cases.push({ kind: "neg_other", quote: pick(usable(other)).s.text.trim() });
    const b = chars(text);
    const span = Math.max(3, Math.round(b.length * 0.35));
    const from = Math.floor(rand() * (b.length - span + 1));
    for (let k = from; k < from + span; k++) b[k] = pick(RANDOM_CHARS[c.lang]);
    cases.push({ kind: "neg_mixed", quote: b.join("") });
    cases.push({ kind: "neg_fabricated", quote: pick(FABRICATED[c.lang]) });
    const x = chars(text);
    const y = chars(pick(segs.filter((q) => Math.abs(q.i - i) > 5).length ? segs.filter((q) => Math.abs(q.i - i) > 5) : segs).s.text);
    cases.push({ kind: "neg_splice", quote: x.slice(0, Math.ceil(x.length / 2)).join("") + y.slice(Math.floor(y.length / 2)).join("") });
    for (let k = first; k < cases.length; k++) cases[k].orig = text; // the transcript line each case was built from
  }
  return cases;
}

// ---- run ---------------------------------------------------------------------
const PER_KIND = 25;
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0];
const DEFAULT = 0.85;

interface Row { kind: Kind; fab: boolean; verified: Record<number, boolean>; quote: string; orig?: string; corpus: string; }
const rows: Row[] = [];
for (const c of corpora) {
  for (const cs of makeCases(c, PER_KIND)) {
    const items: Item[] = [{ text: "-", quote: cs.quote }];
    const verified: Record<number, boolean> = {};
    for (const th of THRESHOLDS) verified[th] = !!verify(items, c.segs, th)[0].verified;
    rows.push({ kind: cs.kind, fab: KIND_INFO[cs.kind].fab, verified, quote: cs.quote, orig: cs.orig, corpus: c.name });
  }
}

// one real generated case per kind from the first corpus, for the slides
writeFileSync(
  resolve("eval/verify-examples.json"),
  JSON.stringify(
    (Object.keys(KIND_INFO) as Kind[]).map((k) => {
      const r = rows.find((x) => x.kind === k && x.corpus === corpora[0].name)!;
      return { kind: k, label: KIND_INFO[k].label, orig: r.orig, quote: r.quote, passed: r.verified[DEFAULT] };
    }),
    null,
    1,
  ) + "\n",
);

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");
function confusion(th: number, subset: Row[] = rows) {
  let TP = 0, FP = 0, FN = 0, TN = 0;
  for (const r of subset) {
    const flagged = !r.verified[th];
    if (r.fab && flagged) TP++;
    else if (r.fab && !flagged) FN++;
    else if (!r.fab && flagged) FP++;
    else TN++;
  }
  const precision = TP / (TP + FP);
  const recall = TP / (TP + FN);
  return { TP, FP, FN, TN, precision, recall, f1: (2 * precision * recall) / (precision + recall), accuracy: (TP + TN) / subset.length };
}

writeFileSync(
  resolve("eval/verify-data.json"),
  JSON.stringify({ default: DEFAULT, rows: THRESHOLDS.map((th) => ({ threshold: th, ...confusion(th) })) }, null, 1) + "\n",
);
const out: string[] = [];
out.push("# ผลวัดตัวตรวจคำอ้างอิง `verify` (เป็นตัวจำแนก)\n");
out.push(`สร้างโดย \`eval/verify_eval.ts\` เมื่อ ${new Date().toISOString()} · seed คงที่ · ไม่ใช้ GPU\n`);
out.push("**ตัวจำแนก:** รับ \"คำอ้างอิง\" ที่ LLM ให้มา แล้วตอบว่า **ตรวจพบในบทถอดเสียง (ผ่าน)** หรือ **ตรวจไม่พบ (ติดป้าย)**");
out.push("**คลาสบวก (positive) = คำอ้างอิงปลอม** (สิ่งที่ตัวตรวจต้องจับ)\n");
out.push("| | ติดป้าย \"ตรวจไม่พบ\" | ผ่าน |\n|---|---|---|\n| ปลอมจริง | TP (จับได้) | FN (หลุด) |\n| ของจริง | FP (จับผิด) | TN (ผ่านถูก) |\n");
out.push(`## ชุดทดสอบ\n\nสร้างจากบทถอดเสียง ${corpora.length} ชุด: ${corpora.map((c) => `${c.name} (${c.segs.length} segment)`).join(", ")}`);
out.push(`แต่ละชุดสร้าง ${PER_KIND} ชุดต่อชนิด × 8 ชนิด = ${PER_KIND * 8} กรณี รวม **${rows.length} กรณี** (ของจริง ${rows.filter((r) => !r.fab).length} / ของปลอม ${rows.filter((r) => r.fab).length})\n`);

out.push("## ผลตามค่าเกณฑ์ (threshold)\n");
out.push("เกณฑ์ = สัดส่วนชิ้นส่วน 4 ตัวอักษรของคำอ้างอิงที่ต้องปรากฏในบทถอดเสียง (ค่าที่ใช้จริงในโปรแกรม = **0.85**) ถ้าคำอ้างอิงไม่ได้เป็นส่วนหนึ่งของบทถอดเสียงตรงตัว\n");
out.push("| เกณฑ์ | TP | FP | FN | TN | Precision | Recall | F1 | Accuracy |\n|---|---|---|---|---|---|---|---|---|");
for (const th of THRESHOLDS) {
  const m = confusion(th);
  out.push(`| ${th}${th === DEFAULT ? " (ใช้จริง)" : ""} | ${m.TP} | ${m.FP} | ${m.FN} | ${m.TN} | ${f2(m.precision)} | ${f2(m.recall)} | ${f2(m.f1)} | ${f2(m.accuracy)} |`);
}

out.push(`\n## แยกตามชนิดกรณี (เกณฑ์ ${DEFAULT})\n`);
out.push("| ชนิด | จำนวน | ผล |\n|---|---|---|");
for (const k of Object.keys(KIND_INFO) as Kind[]) {
  const sub = rows.filter((r) => r.kind === k);
  const accepted = sub.filter((r) => r.verified[DEFAULT]).length;
  const info = KIND_INFO[k];
  out.push(`| ${info.label} | ${sub.length} | ${info.fab ? `หลุดผ่าน ${accepted}/${sub.length} (จับได้ ${((1 - accepted / sub.length) * 100).toFixed(0)}%)` : `ผ่าน ${accepted}/${sub.length} (จับผิด ${(((sub.length - accepted) / sub.length) * 100).toFixed(0)}%)`} |`);
}

out.push("\n## แยกตามชุดบทถอดเสียง (เกณฑ์ 0.85)\n");
out.push("| ชุด | Precision | Recall | F1 | Accuracy |\n|---|---|---|---|---|");
let off = 0;
for (const c of corpora) {
  const sub = rows.slice(off, off + PER_KIND * 8);
  off += PER_KIND * 8;
  const m = confusion(DEFAULT, sub);
  out.push(`| ${c.name} | ${f2(m.precision)} | ${f2(m.recall)} | ${f2(m.f1)} | ${f2(m.accuracy)} |`);
}

out.push("\n## ข้อจำกัด\n");
out.push("- กรณีทดสอบเป็นของ **สร้างขึ้นจากบทถอดเสียงจริงด้วยกฎ** (เปลี่ยนตัวอักษร/ต่อประโยค/แต่งประโยค) ไม่ใช่ผลที่ LLM แต่งเองจริง ๆ จึงบอกได้แค่ความสามารถของตัวตรวจต่อรูปแบบความผิดที่จำลองไว้");
out.push("- บทถอดเสียงมี 3 ชุด ขนาดเล็ก (ข่าวอังกฤษมีไม่กี่ segment) ตัวเลขจึงแกว่งได้ ค่าต่างน้อยกว่า ~0.03 ไม่ควรตีความ");
out.push("- ตัวตรวจจับ **การแต่งข้อความ** ได้ แต่ไม่ได้ตรวจว่ารายการสรุป *ตรงกับ* คำที่อ้างหรือไม่ (เช่น จับคู่รายการกับคำพูดผิดบรรทัด) และถ้าถอดเสียงผิดตั้งแต่ต้นก็ตรวจไม่ได้");
out.push("- **จุดบอดที่เห็นจากผล:** (1) ต่อครึ่งประโยคจาก 2 ที่ห่างกัน หลุดผ่านเกือบทั้งหมด เพราะชิ้นส่วน 4 ตัวอักษรเกือบทุกชิ้นพบในบทถอดเสียง มีแค่ตรงรอยต่อไม่กี่ชิ้น (2) สะกดเพี้ยนเล็กน้อยกระจายทั้งประโยค (~5%) ถูกติดป้ายผิดเกือบทั้งหมด เพราะ 1 ตัวอักษรที่ผิดทำให้ชิ้นส่วนเสียไป 4 ชิ้น จึงต้องเลือกเกณฑ์ระหว่าง Precision กับ Recall");
out.push("- ชนิดกรณีและความรุนแรง (เช่น 5% และ 35%) เป็นตัวเลขที่ผู้ทดลองตั้งเอง ค่าเกณฑ์ที่ได้ F1 ดีที่สุดบนชุดนี้ จึงไม่ใช่ค่าที่พิสูจน์แล้วว่าดีที่สุดกับ LLM จริง โปรแกรมยังใช้ 0.85 ตามเดิม");
writeFileSync(resolve("eval/verify-results.md"), out.join("\n") + "\n");
console.log(out.join("\n"));
