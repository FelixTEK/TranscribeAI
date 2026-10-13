import { Elysia, t } from "elysia";
import { createRecording, deleteRecording, getRecording, listRecordings, queuePosition } from "./db";
import { audioPath, startWorker, tick } from "./worker";

const PORT = Number(Bun.env.PORT ?? 3000);
// one or more bind addresses, comma separated (e.g. "100.x.x.x,127.0.0.1")
const HOSTS = (Bun.env.HOST ?? "127.0.0.1").split(",").map((h) => h.trim()).filter(Boolean);
const PASSWORD = Bun.env.APP_PASSWORD ?? "";
const MAX_BYTES = Number(Bun.env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024;
const AUDIO_EXT = /\.(m4a|mp3|wav|ogg|oga|flac|aac|webm|mp4|opus|amr|3gp)$/i;

const page = Bun.file("public/index.html");

const app = new Elysia()
  .get("/", () => page)
  .get("/health", () => ({ ok: true }))
  .group("/api", (api) =>
    api
      .onBeforeHandle(({ request, set }) => {
        if (PASSWORD && request.headers.get("x-password") !== PASSWORD) {
          set.status = 401;
          return { error: "unauthorized" };
        }
      })
      .get("/recordings", () => listRecordings())
      .get("/recordings/:id", ({ params, set }) => {
        const rec = getRecording(Number(params.id));
        if (!rec) {
          set.status = 404;
          return { error: "not found" };
        }
        return {
          ...rec,
          transcript: rec.transcript ? JSON.parse(rec.transcript) : null,
          summary: rec.summary ? JSON.parse(rec.summary) : null,
          queue_position: rec.status === "queued" ? queuePosition(rec.id) : null,
        };
      })
      .post(
        "/recordings",
        async ({ body, set }) => {
          const { file } = body;
          if (file.size > MAX_BYTES) {
            set.status = 413;
            return { error: "ไฟล์ใหญ่เกินกำหนด" };
          }
          if (!AUDIO_EXT.test(file.name) && !/^(audio|video)\//.test(file.type)) {
            set.status = 415;
            return { error: "รองรับเฉพาะไฟล์เสียง" };
          }
          const title = (body.title?.trim() || file.name.replace(/\.[^.]+$/, "") || "บันทึกเสียง").slice(0, 120);
          const { id } = createRecording(title);
          await Bun.write(audioPath(id), file);
          void tick();
          return { id };
        },
        { body: t.Object({ file: t.File(), title: t.Optional(t.String()) }) },
      )
      .delete("/recordings/:id", ({ params }) => {
        deleteRecording(Number(params.id));
        return { ok: true };
      }),
  )
  ;

const maxRequestBodySize = MAX_BYTES + 1024 * 1024;
for (const hostname of HOSTS) {
  Bun.serve({ port: PORT, hostname, maxRequestBodySize, fetch: app.fetch });
  console.log(`TranscribeAI listening on http://${hostname}:${PORT}`);
}

startWorker();
