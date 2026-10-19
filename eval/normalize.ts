// Text normalisation for CER. Typhoon Whisper writes numbers as Thai words ("สองพันห้าร้อยสามสิบแปด") while the
// FLEURS references use digits ("2538"), which inflates its CER. We rewrite Thai number words as digits on BOTH the
// reference and the hypothesis, so any ambiguous word is handled the same way on both sides and cancels out.

const DIGIT: Record<string, number> = {
  ศูนย์: 0, หนึ่ง: 1, เอ็ด: 1, สอง: 2, ยี่: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9,
};
const UNIT: Record<string, number> = { สิบ: 10, ร้อย: 100, พัน: 1000, หมื่น: 10000, แสน: 100000 };
const MILLION = "ล้าน";

// words that merely start with a number word
const DENY = ["สามารถ", "สามัคคี", "สามี", "สามัญ", "ห้าง", "เก้าอี้", "พันธุ์", "พันธ", "แสนดี", "ร้อยกรอง", "ร้อยละ", "ร้อยเอก", "ร้อยโท"];
const WORDS = [...Object.keys(DIGIT), ...Object.keys(UNIT), MILLION];
const TOKEN = `(?!${DENY.join("|")})(?:${WORDS.join("|")})`;
const CHAIN = new RegExp(`${TOKEN}(?:(?:จุด|ขีด)?${TOKEN})*`, "gu");
const TOKEN_RE = new RegExp(`${WORDS.join("|")}|จุด|ขีด`, "gu");

/** Convert one chain of Thai number words ("ยี่สิบสองขีดเจ็ด") to digits ("227"; the dash/point is dropped later). */
function chainToDigits(chain: string): string {
  const parts = chain.split(/จุด|ขีด/u); // "สองจุดห้า" -> ["สอง","ห้า"], each part is read on its own
  return parts.map(partToDigits).join("");
}

function partToDigits(part: string): string {
  const toks = part.match(TOKEN_RE) ?? [];
  if (!toks.some((t) => t in UNIT || t === MILLION)) return toks.map((t) => String(DIGIT[t])).join(""); // digit by digit
  let result = 0;
  let sub = 0;
  let d: number | null = null;
  for (const t of toks) {
    if (t in DIGIT) d = DIGIT[t];
    else if (t in UNIT) {
      sub += (d ?? 1) * UNIT[t];
      d = null;
    } else {
      sub += d ?? 0;
      result = (result + sub) * 1_000_000;
      sub = 0;
      d = null;
    }
  }
  return String(result + sub + (d ?? 0));
}

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

/** Lowercase, Thai digits -> Arabic, Thai number words -> digits, drop everything except letters, marks and digits. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[๐-๙]/gu, (c) => String(THAI_DIGITS.indexOf(c)))
    .replace(CHAIN, chainToDigits)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

/** The previous normalisation (no number handling), kept to report CER before and after. */
export const normRaw = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
