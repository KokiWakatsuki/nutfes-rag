import { describe, it, expect } from "vitest";
import { chunkText } from "../text";

describe("chunkText", () => {
  it("テキストが maxChars 以下なら 1 チャンクで返す", () => {
    const text = "これはテスト文章です。";
    expect(chunkText(text, 100)).toHaveLength(1);
    expect(chunkText(text, 100)[0]).toBe(text);
  });

  it("空テキストは空配列を返す", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n   ")).toEqual([]);
  });

  it("段落区切りでチャンク分割する", () => {
    const para1 = "あ".repeat(60);
    const para2 = "い".repeat(60);
    const chunks = chunkText(`${para1}\n\n${para2}`, 100, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it("maxChars 超の段落を強制分割する", () => {
    const longPara = "あ".repeat(500);
    const chunks = chunkText(longPara, 200, 0);
    expect(chunks).toHaveLength(Math.ceil(500 / 200));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });

  it("オーバーラップが前チャンク末尾を次チャンク先頭に含む", () => {
    const para1 = "あ".repeat(80);
    const para2 = "い".repeat(80);
    const chunks = chunkText(`${para1}\n\n${para2}`, 100, 20);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].startsWith(chunks[0].slice(-20))).toBe(true);
  });

  it("オーバーラップ後の各チャンクが maxChars + overlapChars 以内に収まる", () => {
    const text = Array.from({ length: 10 }, (_, i) => `段落${i}：${"あ".repeat(150)}`).join("\n\n");
    const maxChars = 1800;
    const overlap = 150;
    const chunks = chunkText(text, maxChars, overlap);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(maxChars + overlap + 2);
  });

  it("全チャンクの内容が元テキストに含まれる（情報損失なし）", () => {
    const paras = Array.from({ length: 5 }, (_, i) => `paragraph${i}content`);
    const text = paras.join("\n\n");
    const chunks = chunkText(text, 50, 0);
    for (const para of paras) {
      const found = chunks.some((c) => c.includes(para));
      expect(found).toBe(true);
    }
  });

  it("overlapChars = 0 のとき純粋な段落分割になる", () => {
    const para1 = "X".repeat(60);
    const para2 = "Y".repeat(60);
    const chunks = chunkText(`${para1}\n\n${para2}`, 100, 0);
    expect(chunks[1]).toBe(para2);
  });
});
