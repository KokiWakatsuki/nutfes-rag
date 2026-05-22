import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const EMBED_MODEL = "gemini-embedding-001";
const CHAT_MODEL = "gemini-2.0-flash";

// Supabase の vector(768) に合わせて次元数を固定
const EMBEDDING_DIMENSIONS = 768;

export async function generateEmbedding(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: EMBED_MODEL });
  const result = await model.embedContent({
    content: { parts: [{ text }], role: "user" },
    outputDimensionality: EMBEDDING_DIMENSIONS,
  } as Parameters<typeof model.embedContent>[0]);
  return result.embedding.values;
}

// 複数チャンクを1回のAPI呼び出しでまとめて処理する
// batchEmbedContents がクォータ1消費/バッチなら処理速度が大幅改善
export async function generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  const model = genAI.getGenerativeModel({ model: EMBED_MODEL });
  const result = await model.batchEmbedContents({
    requests: texts.map((text) => ({
      content: { parts: [{ text }], role: "user" },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    })),
  });
  return result.embeddings.map((e) => e.values);
}

export async function generateAnswer(
  question: string,
  contexts: Array<{ file_name: string; content: string; edition: number }>
): Promise<string> {
  const model = genAI.getGenerativeModel({ model: CHAT_MODEL });

  const contextText = contexts
    .map(
      (c, i) =>
        `【資料 ${i + 1}: ${c.file_name}（第${c.edition}回）】\n${c.content}`
    )
    .join("\n\n---\n\n");

  const prompt = `あなたは学祭実行委員のAIアシスタントです。
以下の資料を参考にして、質問に日本語で答えてください。
資料に記載されていない内容については「資料には記載がありません」と明示してください。

【参考資料】
${contextText}

【質問】
${question}

【回答】`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}
