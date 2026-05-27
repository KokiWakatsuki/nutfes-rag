import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT!;
const GCS_BUCKET = process.env.GCS_BUCKET;
const LOCATION = "us-central1";
const EMBED_MODEL = "text-embedding-004";
const CHAT_MODEL = "gemini-2.5-flash";
const EMBEDDING_DIMENSIONS = 768;
const GEMINI_INLINE_LIMIT = 20 * 1024 * 1024;

let _auth: InstanceType<typeof google.auth.GoogleAuth> | null = null;

function getAuth() {
  if (!_auth) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!);
    _auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/generative-language",
      ],
    });
  }
  return _auth;
}

async function getAccessToken(): Promise<string> {
  const client = await getAuth().getClient();
  const res = await client.getAccessToken();
  return res.token!;
}

function vertexUrl(model: string, method: string): string {
  return `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${model}:${method}`;
}


export async function generateEmbedding(text: string): Promise<number[]> {
  const [embedding] = await generateEmbeddingBatch([text]);
  return embedding;
}

export async function generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  const token = await getAccessToken();
  const res = await fetch(vertexUrl(EMBED_MODEL, "predict"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: texts.map((content) => ({ content })),
      parameters: { outputDimensionality: EMBEDDING_DIMENSIONS },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vertex AI embedding error ${res.status}: ${err}`);
  }
  const data = await res.json() as {
    predictions: Array<{ embeddings: { values: number[] } }>;
  };
  return data.predictions.map((p) => p.embeddings.values);
}

const OCR_PROMPT = "このファイルに含まれるテキストをすべて書き起こしてください。表・図・画像内の文字も含めてください。書き起こした内容のみを出力してください。";

async function geminiGenerateContent(parts: object[]): Promise<string> {
  const token = await getAccessToken();
  const res = await fetch(vertexUrl(CHAT_MODEL, "generateContent"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini OCR error ${res.status}: ${err}`);
  }
  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

export async function extractFileContent(
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  if (buffer.length <= GEMINI_INLINE_LIMIT) {
    return geminiGenerateContent([
      { inlineData: { mimeType, data: buffer.toString("base64") } },
      { text: OCR_PROMPT },
    ]);
  }

  // 20MB 超 → GCS に一時アップロードして fileUri で渡す
  if (!GCS_BUCKET) {
    throw new Error(
      `ファイルサイズ超過 (${(buffer.length / 1024 / 1024).toFixed(1)} MB > 20 MB)。GCS_BUCKET を設定してください。`
    );
  }
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!);
  const storage = new Storage({ credentials, projectId: PROJECT });
  const objectName = `tmp-ocr/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await storage.bucket(GCS_BUCKET).file(objectName).save(buffer, { contentType: mimeType });
  try {
    return await geminiGenerateContent([
      { fileData: { mimeType, fileUri: `gs://${GCS_BUCKET}/${objectName}` } },
      { text: OCR_PROMPT },
    ]);
  } finally {
    await storage.bucket(GCS_BUCKET).file(objectName).delete().catch(() => {});
  }
}

export async function generateAnswer(
  question: string,
  contexts: Array<{ file_name: string; content: string; edition: number }>
): Promise<string> {
  const token = await getAccessToken();
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

  const res = await fetch(vertexUrl(CHAT_MODEL, "generateContent"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini generation error ${res.status}: ${err}`);
  }
  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
