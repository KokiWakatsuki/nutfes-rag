import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";
import { PDFDocument } from "pdf-lib";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT!;
const GCS_BUCKET = process.env.GCS_BUCKET;
const LOCATION = "us-central1";
const EMBED_MODEL = "text-embedding-004";
const CHAT_MODEL = "gemini-2.5-flash";
const EMBEDDING_DIMENSIONS = 768;
const GEMINI_INLINE_LIMIT = 20 * 1024 * 1024;
// 1リクエストあたりの安全処理サイズ: ~1MB/s想定で90s以内に収まるよう10MBに設定
const PDF_SAFE_CHUNK_SIZE = 10 * 1024 * 1024;
// Gemini OCR 1リクエストのタイムアウト
const GEMINI_OCR_TIMEOUT_MS = 90_000;

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

// 永続的にスキップすべきエラー（リトライしても無意味）
export class GeminiSkippableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiSkippableError";
  }
}

async function geminiGenerateContent(parts: object[]): Promise<string> {
  const token = await getAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_OCR_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(vertexUrl(CHAT_MODEL, "generateContent"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Gemini OCR timeout after ${GEMINI_OCR_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = await res.text();
    // 破損ファイル・サイズ超過は永続的エラー → スキップ可能として扱う
    if (res.status === 400) {
      if (err.includes("not valid") || err.includes("no pages")) {
        throw new GeminiSkippableError(`Gemini OCR skippable: ${err.slice(0, 200)}`);
      }
    }
    throw new Error(`Gemini OCR error ${res.status}: ${err}`);
  }
  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

const GCS_PDF_LIMIT = 50 * 1024 * 1024; // Gemini GCS PDF 上限 50MB

async function uploadToGcsAndExtract(
  storage: Storage,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const objectName = `tmp-ocr/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await storage.bucket(GCS_BUCKET!).file(objectName).save(buffer, { contentType: mimeType });
  try {
    return await geminiGenerateContent([
      { fileData: { mimeType, fileUri: `gs://${GCS_BUCKET}/${objectName}` } },
      { text: OCR_PROMPT },
    ]);
  } finally {
    await storage.bucket(GCS_BUCKET!).file(objectName).delete().catch(() => {});
  }
}

// PDFをページ単位で分割してGeminiに送り、結果を結合する
async function extractLargePdf(buffer: Buffer, storage: Storage): Promise<string> {
  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();
  const bytesPerPage = Math.max(1, buffer.length / totalPages);
  // PDF_SAFE_CHUNK_SIZE ベースでチャンク数を決定（GCS上限50MBも超えない）
  const safeChunkSize = Math.min(PDF_SAFE_CHUNK_SIZE, GCS_PDF_LIMIT * 0.9);
  const pagesPerChunk = Math.max(1, Math.floor(safeChunkSize / bytesPerPage));

  process.stdout.write(
    `  PDF分割: ${totalPages}ページ / ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${Math.ceil(totalPages / pagesPerChunk)}チャンク (上限${(safeChunkSize / 1024 / 1024).toFixed(0)}MB/チャンク)\n`
  );

  const results: string[] = [];
  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages);
    const chunk = await PDFDocument.create();
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
    const pages = await chunk.copyPages(pdfDoc, pageIndices);
    pages.forEach((p: ReturnType<typeof chunk.addPage>) => chunk.addPage(p));
    const chunkBytes = Buffer.from(await chunk.save());
    const text = await uploadToGcsAndExtract(storage, chunkBytes, "application/pdf");
    if (text.trim()) results.push(text.trim());
  }
  return results.join("\n\n");
}

export async function extractFileContent(
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  // PDFは PDF_SAFE_CHUNK_SIZE 超でプロアクティブ分割（タイムアウト防止）
  if (mimeType === "application/pdf" && buffer.length > PDF_SAFE_CHUNK_SIZE) {
    if (!GCS_BUCKET) {
      throw new Error(
        `PDF分割にはGCSが必要です (${(buffer.length / 1024 / 1024).toFixed(1)} MB > ${PDF_SAFE_CHUNK_SIZE / 1024 / 1024} MB)。GCS_BUCKET を設定してください。`
      );
    }
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!);
    const storage = new Storage({ credentials, projectId: PROJECT });
    return extractLargePdf(buffer, storage);
  }

  // PDF以外・小サイズPDF: 20MB 以下はインライン送信
  if (buffer.length <= GEMINI_INLINE_LIMIT) {
    return geminiGenerateContent([
      { inlineData: { mimeType, data: buffer.toString("base64") } },
      { text: OCR_PROMPT },
    ]);
  }

  // 20MB 超の非PDF → GCS 経由（単一リクエスト、90sタイムアウト内に収まる想定）
  if (!GCS_BUCKET) {
    throw new Error(
      `ファイルサイズ超過 (${(buffer.length / 1024 / 1024).toFixed(1)} MB > 20 MB)。GCS_BUCKET を設定してください。`
    );
  }
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!);
  const storage = new Storage({ credentials, projectId: PROJECT });
  return uploadToGcsAndExtract(storage, buffer, mimeType);
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
