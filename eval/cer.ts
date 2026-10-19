// Character error rate: Levenshtein alignment split into substitutions / deletions / insertions.

/** Levenshtein with backtrace -> substitutions, deletions (missed ref chars), insertions (extra hyp chars) */
export function edit(ref: string, hyp: string) {
  const a = Array.from(ref);
  const b = Array.from(hyp);
  const n = a.length;
  const m = b.length;
  const ops = new Uint8Array((n + 1) * (m + 1)); // 0 match/sub(diag) 1 deletion(up) 2 insertion(left)
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    ops[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    ops[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const up = prev[j] + 1;
      const left = cur[j - 1] + 1;
      if (diag <= up && diag <= left) {
        cur[j] = diag;
        ops[i * (m + 1) + j] = 0;
      } else if (up <= left) {
        cur[j] = up;
        ops[i * (m + 1) + j] = 1;
      } else {
        cur[j] = left;
        ops[i * (m + 1) + j] = 2;
      }
    }
    [prev, cur] = [cur, prev];
  }
  let i = n;
  let j = m;
  let S = 0;
  let D = 0;
  let I = 0;
  while (i > 0 || j > 0) {
    const op = ops[i * (m + 1) + j];
    if (op === 0) {
      if (a[i - 1] !== b[j - 1]) S++;
      i--;
      j--;
    } else if (op === 1) {
      D++;
      i--;
    } else {
      I++;
      j--;
    }
  }
  return { S, D, I, N: n, cer: (S + D + I) / n };
}
