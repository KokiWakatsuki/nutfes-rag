// text-embedding-004: 日本語は 1文字≒1トークン、上限2048トークン
// 1800文字 + 150オーバーラップ = 最大1950文字 < 2048トークン で安全に収まる
export function chunkText(text: string, maxChars = 1800, overlapChars = 150): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const rawChunks: string[] = [];
  let buf = "";

  for (const para of paras) {
    // 段落自体が上限超 → 文字数で強制分割
    if (para.length > maxChars) {
      if (buf.trim()) { rawChunks.push(buf.trim()); buf = ""; }
      for (let i = 0; i < para.length; i += maxChars) {
        rawChunks.push(para.slice(i, i + maxChars));
      }
      continue;
    }
    if (buf.length + para.length + 2 > maxChars && buf.trim()) {
      rawChunks.push(buf.trim());
      buf = "";
    }
    buf += para + "\n\n";
  }
  if (buf.trim()) rawChunks.push(buf.trim());

  // 前チャンクの末尾 overlapChars 文字を次チャンク先頭に付加してコンテキスト損失を防ぐ
  if (rawChunks.length <= 1 || overlapChars <= 0) return rawChunks;
  return rawChunks.map((chunk, i) =>
    i === 0 ? chunk : rawChunks[i - 1].slice(-overlapChars) + "\n\n" + chunk
  );
}
