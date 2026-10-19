import { expect, test } from "bun:test";
import { dropTailHallucinations, type Segment } from "./prompt";

const seg = (text: string, start = 0): Segment => ({ start, end: start + 1, text });

test("drops a trailing sign-off that is not in the audio", () => {
  const out = dropTailHallucinations([seg("请问,你贵姓。", 0), seg("我姓张。", 2), seg("感谢观看", 4)]);
  expect(out.map((s) => s.text)).toEqual(["请问,你贵姓。", "我姓张。"]);
});

test("also drops several stacked sign-offs, ignoring spaces and punctuation", () => {
  const out = dropTailHallucinations([seg("สวัสดีครับ"), seg("ขอบคุณที่รับชม"), seg(" Thanks for watching! ")]);
  expect(out.map((s) => s.text)).toEqual(["สวัสดีครับ"]);
});

test("keeps the phrase when it is inside a longer sentence or not at the end", () => {
  const a = dropTailHallucinations([seg("ขอบคุณที่รับชมและติดตามช่องของเรา")]);
  expect(a).toHaveLength(1);
  const b = dropTailHallucinations([seg("感谢观看"), seg("พรุ่งนี้เจอกัน")]);
  expect(b).toHaveLength(2);
});

test("leaves ordinary transcripts alone", () => {
  const input = [seg("เรื่องแรก"), seg("เรื่องที่สอง")];
  expect(dropTailHallucinations(input)).toEqual(input);
});
