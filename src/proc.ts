import { unlinkSync } from "node:fs";

/** Run a command to completion; `onData` sees stdout/stderr text as it arrives. */
export async function run(cmd: string[], onData?: (chunk: string) => void): Promise<{ out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let text = "";
    for await (const c of stream) {
      const s = dec.decode(c, { stream: true });
      text += s;
      onData?.(s);
    }
    return text;
  };
  const [out, err, code] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}: ${err.slice(-500)}`);
  return { out, err };
}

export const rm = (...files: string[]) => {
  for (const f of files) {
    try {
      unlinkSync(f);
    } catch {}
  }
};
