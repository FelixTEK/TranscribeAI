# TranscribeAI

ถอดเสียงและสรุปบันทึกเสียงภาษาไทย **ทั้งหมดรันในเครื่อง (GPU)** ไม่ส่งข้อมูลออกนอกเครื่อง
เหมาะกับการบันทึกสายคุยแล้วดูว่า "ใครขอให้ทำอะไร / ถามอะไร / ผมรับปากอะไรไว้"

```
.m4a → ffmpeg → .wav → whisper.cpp (GPU) → ลบเสียง → Typhoon 4B / llama.cpp (GPU) → สรุป → SQLite
```

- Backend: Bun + Elysia, SQLite (`bun:sqlite`), คิวงานทีละงาน (ถอดเสียงทุกงานก่อน แล้วค่อยสรุป เพื่อไม่ให้สองโมเดลใช้ VRAM 4GB พร้อมกัน)
- ไฟล์เสียงถูกลบทันทีหลังถอดเสียง (หรือเมื่อเกิด error) เก็บเฉพาะข้อความ
- ทุกรายการสรุปต้องมี "คำพูดอ้างอิง" ที่ระบบตรวจว่ามีอยู่จริงใน transcript ถ้าไม่พบจะมีป้าย "ตรวจไม่พบ"

## ติดตั้ง (Windows)

ต้องมี: ไดรเวอร์ NVIDIA, ffmpeg, Bun

```powershell
winget install Gyan.FFmpeg Oven-sh.Bun
bun install
copy .env.example .env
```

ดาวน์โหลดไบนารีและโมเดลไปไว้ใน `bin/` และ `models/` (ทั้งสองโฟลเดอร์อยู่นอก git):

| ไฟล์ | แหล่ง | ไว้ที่ |
|---|---|---|
| `whisper-bin-win-cuda-12.4.0-x64.zip` | GitHub Releases ของ `ggml-org/whisper.cpp` | แตกไปที่ `bin/whisper/` |
| `llama-<tag>-bin-win-cuda-12.4-x64.zip` และ `cudart-llama-bin-win-cuda-12.4-x64.zip` | GitHub Releases ของ `ggml-org/llama.cpp` | แตกทั้งคู่ไปที่ `bin/llama/` |
| `ggml-large-v3-turbo-q8_0.bin` | Hugging Face `ggerganov/whisper.cpp` | `models/` |
| `ggml-silero-v6.2.0.bin` (VAD) | Hugging Face `ggml-org/whisper-vad` | `models/` |
| `typhoon2.5-qwen3-4b-q4_k_m.gguf` | Hugging Face `boatchrnthn/typhoon2.5-qwen3-4b-Q4_K_M-GGUF` (แปลงจาก `scb10x/typhoon2.5-qwen3-4b`) | `models/` |

ชื่อไฟล์และ path แก้ได้ใน `.env`

## รัน

```powershell
bun run start
```

เปิด http://localhost:3000 อัปโหลดไฟล์เสียง ปิดหน้าเว็บได้ ระบบทำงานต่อเบื้องหลัง

## ใช้จากมือถือผ่าน Tailscale

1. ติดตั้ง Tailscale บน NB และมือถือ แล้วล็อกอินบัญชีเดียวกัน
2. เปิดฟีเจอร์ Serve ครั้งเดียวในหน้า admin ของ Tailscale (คำสั่งข้างล่างจะพิมพ์ลิงก์ให้)
3. บน NB:

```powershell
tailscale serve --bg 3000
```

4. เปิด `https://<ชื่อเครื่อง>.<tailnet>.ts.net` บนมือถือ (เปิดแอป Tailscale ก่อน) แล้ว Add to Home screen

อย่าใช้ `tailscale funnel` (เปิดสู่อินเทอร์เน็ตสาธารณะ) เซิร์ฟเวอร์ฟังเฉพาะ `127.0.0.1` โดยตั้งใจ
ถ้าต้องการอีกชั้น ตั้ง `APP_PASSWORD` ใน `.env`

NB ต้องไม่ sleep ตอนเสียบปลั๊ก (Settings → Power)

## ค่าที่ปรับได้ (`.env`)

| ตัวแปร | ค่าเริ่มต้น | หมายเหตุ |
|---|---|---|
| `LLM_CTX` | 8192 | วัดจริงบน RTX 2050 4GB: ใช้ VRAM ~3.6 GB (KV cache q8_0) |
| `CHUNK_MINUTES` | 8 | ช่วงละ ~4.5k token ภาษาไทย ถ้าเสียงพูดหนาแน่นมากให้ลด |
| `LLM_TEMP` | 0.2 | ต่ำเพื่อลดการแต่งเรื่อง |
| `KEEP_AUDIO_DAYS` | 0 | 0 = ลบเสียงทันที |
| `APP_PASSWORD` | ว่าง | ถ้าตั้ง ทุก request ของ API ต้องส่ง header `x-password` |

## ข้อจำกัดที่รู้แล้ว

- ผลสรุปมาจาก AI ตรวจซ้ำในเรื่องสำคัญ โดยเฉพาะตัวเลข วันที่ ชื่อ จำนวนเงิน
- คำอ้างอิงที่ตรวจพบจับ "แต่งเรื่อง" ได้ แต่จับ "Whisper ฟังผิดตั้งแต่ต้น" ไม่ได้ และอาจจับคู่รายการกับคำพูดผิดบรรทัดได้
- Whisper บางครั้งถอดศัพท์เทคนิคและชื่อเฉพาะผิด
- การอัดสายโทรศัพท์ขึ้นกับรุ่นและแอปบนมือถือ (Android อัดสายได้ไม่ทุกเครื่อง)
- ถ้าบันทึกเสียงของคนอื่น ควรแจ้งให้เขาทราบ
