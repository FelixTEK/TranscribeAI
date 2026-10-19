import { expect, test } from "bun:test";
import { normText } from "./normalize";

test("Thai number words become digits", () => {
  expect(normText("สองพันห้าร้อยสามสิบแปด")).toBe("2538");
  expect(normText("ยี่สิบเอ็ด")).toBe("21");
  expect(normText("สิบ")).toBe("10");
  expect(normText("หนึ่งล้านสองแสน")).toBe("1200000");
  expect(normText("สองพันห้าร้อยหกสิบเก้า")).toBe("2569");
  expect(normText("ศูนย์แปดหนึ่งสองสาม")).toBe("081" + "23");
});

test("dash and decimal point between numbers", () => {
  expect(normText("ยี่สิบสองขีดเจ็ด")).toBe("227"); // reference "22-7"
  expect(normText("22-7")).toBe("227");
  expect(normText("สองจุดห้า")).toBe("25"); // reference "2.5"
  expect(normText("2.5")).toBe("25");
});

test("digits written in different ways agree", () => {
  expect(normText("2,569")).toBe(normText("สองพันห้าร้อยหกสิบเก้า"));
  expect(normText("๒๕๓๘")).toBe("2538");
});

test("words that only start with a number word are left alone", () => {
  expect(normText("สามารถ")).toBe("สามารถ");
  expect(normText("ห้างสรรพสินค้า")).toBe("ห้างสรรพสินค้า");
  expect(normText("ร้อยละ 50")).toBe("ร้อยละ50");
});

test("non-number text only loses spaces and punctuation", () => {
  expect(normText("Hello, World! สวัสดี")).toBe("helloworldสวัสดี");
});
