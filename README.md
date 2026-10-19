# TranscribeAI

ถอดเสียงและสรุปบันทึกเสียงภาษาไทย **ทั้งหมดรันในเครื่อง (GPU)** ไม่ส่งข้อมูลออกนอกเครื่อง (PDPA)
ใช้ได้กับสายคุย การประชุม การบรรยาย หรือข่าว ผลสรุปมี 4 ส่วน: **ภาพรวม · Keywords · รายละเอียดประกอบ · สิ่งที่น่าสนใจ**

โปรเจกต์วิชาปัญญาประดิษฐ์ (05506210) เป็นการ **ประยุกต์โมเดลสำเร็จรูป** (Whisper สำหรับถอดเสียง, LLM สำหรับสรุป) แล้วปรับปรุงวิธีใช้ให้ทำงานได้บน GPU 4 GB และ **วัดผลด้วยตัวชี้วัด** ไม่ได้เทรนโมเดลเอง ผลทดลองอยู่ในโฟลเดอร์ `eval/` และ `docs/`

```
.m4a → ffmpeg → .wav → ตัดท่อน (Silero VAD + พลังงานเสียง) → Whisper (GPU) → ลบเสียง
     → ล้างข้อความวนซ้ำ/คำหลอนท้ายไฟล์ → LLM Typhoon 4B / llama.cpp (GPU) แบ่งช่วง 8 นาที
     → ตรวจคำอ้างอิงกับบทถอดเสียง → SQLite → หน้าเว็บ
```

- Backend: Bun + Elysia, SQLite (`bun:sqlite`), คิวงานทีละงาน (ถอดเสียงทุกงานก่อน แล้วค่อยสรุป เพื่อไม่ให้สองโมเดลใช้ VRAM 4 GB พร้อมกัน)
- ไฟล์เสียงถูกลบทันทีหลังถอดเสียง (หรือเมื่อเกิด error) เก็บเฉพาะข้อความ
- ทุกรายการสรุปมี "คำพูดอ้างอิง" ที่ระบบตรวจว่ามีอยู่จริงในบทถอดเสียง ถ้าไม่พบจะมีป้าย "ตรวจไม่พบ" กดคำอ้างอิงเพื่อเลื่อนไปจุดนั้นในบทถอดเสียง
- หน้าเว็บใช้ได้ทั้งเดสก์ท็อปและมือถือ

## ความต้องการ

- Windows 11 + GPU NVIDIA (ทดสอบบน RTX 2050 4 GB) + ไดรเวอร์ล่าสุด
- ffmpeg, Bun

## ติดตั้ง (Windows)

```powershell
winget install Gyan.FFmpeg Oven-sh.Bun
bun install
copy .env.example .env
```

ดาวน์โหลดไบนารีและโมเดลไปไว้ใน `bin/` และ `models/` (ทั้งสองโฟลเดอร์อยู่นอก git และไม่ได้แนบมากับงานส่ง):

| ไฟล์ | แหล่ง | ไว้ที่ |
|---|---|---|
| `whisper-bin-win-cuda-12.4.0-x64.zip` | GitHub Releases ของ `ggml-org/whisper.cpp` | แตกไปที่ `bin/whisper/` |
| `llama-<tag>-bin-win-cuda-12.4-x64.zip` และ `cudart-llama-bin-win-cuda-12.4-x64.zip` | GitHub Releases ของ `ggml-org/llama.cpp` | แตกทั้งคู่ไปที่ `bin/llama/` |
| `ggml-large-v3-turbo-q8_0.bin` (ถอดเสียงหลายภาษา เร็ว) | Hugging Face `ggerganov/whisper.cpp` | `models/` |
| `ggml-typhoon-large-v3-q8_0.bin` (ถอดเสียงไทย แม่นสุด ดูหัวข้อถัดไป) | แปลงเองจาก `typhoon-ai/typhoon-whisper-large-v3` | `models/` |
| `ggml-silero-v6.2.0.bin` (VAD) | Hugging Face `ggml-org/whisper-vad` | `models/` |
| `typhoon2.5-qwen3-4b-q4_k_m.gguf` | Hugging Face `boatchrnthn/typhoon2.5-qwen3-4b-Q4_K_M-GGUF` (แปลงจาก `scb10x/typhoon2.5-qwen3-4b`) | `models/` |

ชื่อไฟล์และ path แก้ได้ใน `.env`

### แปลง Typhoon Whisper เป็นไฟล์ ggml (ทำครั้งเดียว)

ต้องมี Python + PyTorch + `transformers` และโคลน 2 รีโป (ตัวแปลงของ whisper.cpp ต้องใช้โค้ดของ OpenAI ประกอบ) ขั้นตอนนี้ใช้ครั้งแรกตอนสร้างไฟล์ในโปรเจกต์นี้ แต่ **ยังไม่ได้รันซ้ำจากศูนย์เพื่อยืนยัน** ถ้าติดปัญหาให้ดูเอกสารของ `ggml-org/whisper.cpp` หัวข้อ "Fine-tuned models":

```powershell
git clone https://github.com/ggml-org/whisper.cpp
git clone https://github.com/openai/whisper
git clone https://huggingface.co/typhoon-ai/typhoon-whisper-large-v3
python whisper.cpp/models/convert-h5-to-ggml.py typhoon-whisper-large-v3 whisper .
bin\whisper\Release\whisper-quantize.exe ggml-model.bin models\ggml-typhoon-large-v3-q8_0.bin q8_0
```

## รัน

```powershell
bun run start
```

เปิด http://localhost:3000 อัปโหลดไฟล์เสียง ปิดหน้าเว็บได้ ระบบทำงานต่อเบื้องหลัง
ไฟล์สั้น 30–60 วินาทีใช้เวลาถอดและสรุปรวมราว 1–2 นาที (ครั้งแรกอาจนานกว่าเพราะโหลดโมเดล)

## เลือกโมเดลถอดเสียง

ตั้งใน `.env` (แก้แล้วรีสตาร์ท `bun run start`):

| ต้องการ | `WHISPER_MODEL` | `WHISPER_MODE` | `WHISPER_LANG` |
|---|---|---|---|
| ไทย แม่นสุด (ค่าเริ่มต้นใน `.env.example`) | `models/ggml-typhoon-large-v3-q8_0.bin` | `chunked` | `th` |
| หลายภาษา เร็วกว่า 4–5 เท่า มี timestamp ละเอียด | `models/ggml-large-v3-turbo-q8_0.bin` | `direct` | `auto` |

- `chunked` = ตัดท่อนตามช่วงหยุดพูดแล้วถอดทีละท่อน (จำเป็นสำหรับ Typhoon ซึ่งไม่ให้ timestamp) · `direct` = ถอดทั้งไฟล์รวดเดียว
- Typhoon ใช้ได้เฉพาะภาษาไทย ภาษาอื่นจะถูกเขียนเป็นอักษรไทย (ดู `eval/results-lang.md`)
- ผลเทียบความแม่นและเวลา: `eval/results.md`

## ใช้จากมือถือผ่าน Tailscale

1. ติดตั้ง Tailscale บน NB และมือถือ แล้วล็อกอินบัญชีเดียวกัน
2. เปิดฟีเจอร์ Serve ครั้งเดียวในหน้า admin ของ Tailscale (คำสั่งข้างล่างจะพิมพ์ลิงก์ให้)
3. บน NB:

```powershell
tailscale serve --bg 3000
```

4. เปิด `https://<ชื่อเครื่อง>.<tailnet>.ts.net` บนมือถือ (เปิดแอป Tailscale ก่อน) แล้ว Add to Home screen

อย่าใช้ `tailscale funnel` (เปิดสู่อินเทอร์เน็ตสาธารณะ) ค่าเริ่มต้นเซิร์ฟเวอร์ฟังเฉพาะ `127.0.0.1` โดยตั้งใจ ถ้าต้องการให้ฟังที่ IP ของ Tailscale ด้วย ตั้ง `HOST=<ip tailscale>,127.0.0.1` ใน `.env`
ถ้าต้องการอีกชั้น ตั้ง `APP_PASSWORD` ใน `.env`

NB ต้องไม่ sleep ตอนเสียบปลั๊ก (Settings → Power)

## ค่าที่ปรับได้ (`.env`)

| ตัวแปร | ค่าเริ่มต้น | หมายเหตุ |
|---|---|---|
| `CHUNK_SECONDS` | 25 | ความยาวท่อนเสียงสูงสุดที่ส่งให้ Whisper (หน้าต่างของ Whisper คือ 30 วินาที) |
| `DROP_SILENCE_SECONDS` | 2 | ทิ้งช่วงเงียบที่ยาวตั้งแต่ค่านี้ (ส่งช่วงเงียบให้ Whisper แล้วมันแต่งข้อความเอง) |
| `LLM_CTX` | 8192 | วัดจริงบน RTX 2050 4GB: ใช้ VRAM ~3.6 GB (KV cache q8_0) |
| `CHUNK_MINUTES` | 8 | ช่วงละ ~4.5k token ภาษาไทย ถ้าเสียงพูดหนาแน่นมากให้ลด |
| `LLM_TEMP` | 0.2 | ต่ำเพื่อลดการแต่งเรื่อง |
| `KEEP_AUDIO_DAYS` | 0 | 0 = ลบเสียงทันที |
| `APP_PASSWORD` | ว่าง | ถ้าตั้ง ทุก request ของ API ต้องส่ง header `x-password` |

## วัดผลและทดสอบ

สคริปต์อยู่ใน `eval/` รันจากโฟลเดอร์ราก ข้อมูลเสียงและผลดิบอยู่ใน `data/eval/` (ไม่อยู่ใน git) ผลสรุปที่อ่านได้อยู่ใน `eval/*.md`

```powershell
bun test                         # ทดสอบหน่วย (ตัวกรองคำหลอน, แปลงตัวเลข)
bun eval/split.ts                # แบ่ง FLEURS 79 ประโยคเป็น dev 40 / test 39
bun eval/make_long.ts [split]    # สร้างไฟล์ยาว L1/L2 (หรือ LD/LT ถ้าใส่ split)
bun eval/run_long.ts C3,C4 LT    # ถอดเสียงตามการตั้งค่า C1–C5 (ใช้ GPU ทีละงาน)
bun eval/metrics.ts              # คำนวณ CER, S/D/I -> eval/results.md
bun eval/run_search.ts all       # beam search และ Hill-Climbing -> eval/search-results.md (ใช้ GPU)
bun eval/verify_eval.ts          # วัดตัวตรวจคำอ้างอิงเป็นตัวจำแนก (P/R/F1) -> eval/verify-results.md
```

| ไฟล์ผล | เนื้อหา |
|---|---|
| `eval/results.md` | CER ของ 6 การตั้งค่าบนไฟล์ยาว L1/L2/LD/LT และ FLEURS ไฟล์สั้น |
| `eval/results-lang.md` | ทดสอบไทย/อังกฤษ/จีน |
| `eval/search-results.md` | greedy เทียบ beam, Hill-Climbing ปรับค่าตัดท่อน |
| `eval/verify-results.md` | Precision/Recall/F1 ของตัวตรวจคำอ้างอิง |

## ข้อจำกัดที่รู้แล้ว

- ผลสรุปมาจาก AI ตรวจซ้ำในเรื่องสำคัญ โดยเฉพาะตัวเลข วันที่ ชื่อ จำนวนเงิน
- คำอ้างอิงที่ตรวจพบจับ "แต่งเรื่อง" ได้ แต่จับ "Whisper ฟังผิดตั้งแต่ต้น" ไม่ได้ และอาจจับคู่รายการกับคำพูดผิดบรรทัดได้ (วัดจุดอ่อนไว้ใน `eval/verify-results.md`)
- Whisper บางครั้งถอดศัพท์เทคนิคและชื่อเฉพาะผิด
- ข้อมูลทดสอบหลักเป็นเสียงอ่านสะอาด (FLEURS) ยังไม่ได้ทดสอบกับสายโทรศัพท์จริงในปริมาณมาก
- การอัดสายโทรศัพท์ขึ้นกับรุ่นและแอปบนมือถือ (Android อัดสายได้ไม่ทุกเครื่อง)
- ถ้าบันทึกเสียงของคนอื่น ควรแจ้งให้เขาทราบ
