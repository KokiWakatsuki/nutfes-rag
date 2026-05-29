import { google } from "googleapis";
import { Storage } from "@google-cloud/storage";
import { PDFDocument } from "pdf-lib";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

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

const OCR_PROMPT = "このファイルに含まれるすべての情報を抽出してください。テキストはそのまま書き起こし、図・画像・レイアウト図・配置図などテキスト以外の要素も内容と構造を詳しく説明してください。出力はテキストのみでお願いします。";

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
    // 破損ファイル・暗号化・サイズ超過など永続的に処理不能なケース
    if (res.status === 400) {
      const skipPatterns = ["not valid", "no pages", "Invalid PDF", "encrypted", "password", "INVALID_ARGUMENT"];
      if (skipPatterns.some((p) => err.includes(p))) {
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

const GCS_PDF_LIMIT = 50 * 1024 * 1024;

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

// GCS上限超えチャンクをghostscriptでJPEGに変換してGemini OCR
async function renderPdfToJpegs(pdfBuffer: Buffer): Promise<Buffer[]> {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpPdf = join(tmpdir(), `pdfocr-${uid}.pdf`);
  const tmpPrefix = join(tmpdir(), `pdfocr-${uid}`);
  writeFileSync(tmpPdf, pdfBuffer);
  try {
    await execFileAsync("gs", [
      "-dNOPAUSE", "-dBATCH", "-dSAFER",
      "-sDEVICE=jpeg", "-r150", "-dJPEGQ=90",
      `-sOutputFile=${tmpPrefix}-%03d.jpg`,
      tmpPdf,
    ], { timeout: 180_000 });

    const images: Buffer[] = [];
    for (let p = 1; ; p++) {
      const jpgPath = `${tmpPrefix}-${String(p).padStart(3, "0")}.jpg`;
      if (!existsSync(jpgPath)) break;
      const buf = readFileSync(jpgPath);
      unlinkSync(jpgPath);
      process.stdout.write(`    → p${p} JPEG ${(buf.length / 1024 / 1024).toFixed(1)}MB\n`);
      images.push(buf);
    }
    if (images.length === 0) throw new GeminiSkippableError("ghostscript: ページ画像が生成されませんでした");
    return images;
  } finally {
    try { unlinkSync(tmpPdf); } catch {}
  }
}

// PDFをページ単位で分割してGeminiに送り、結果を結合する
async function extractLargePdf(buffer: Buffer, storage: Storage): Promise<string> {
  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();
  const bytesPerPage = Math.max(1, buffer.length / totalPages);
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

    if (chunkBytes.length > GCS_PDF_LIMIT) {
      process.stdout.write(
        `  チャンク(p${start + 1}-${end}) ${(chunkBytes.length / 1024 / 1024).toFixed(1)}MB > GCS上限 → JPEG変換してOCR\n`
      );
      const jpegs = await renderPdfToJpegs(chunkBytes);
      for (const jpeg of jpegs) {
        const text = await geminiGenerateContent([
          { inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } },
          { text: OCR_PROMPT },
        ]);
        if (text.trim()) results.push(text.trim());
      }
      continue;
    }

    const text = await uploadToGcsAndExtract(storage, chunkBytes, "application/pdf");
    if (text.trim()) results.push(text.trim());
  }
  return results.join("\n\n");
}

export async function extractFileContent(
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  if (mimeType === "application/pdf" && buffer.length > PDF_SAFE_CHUNK_SIZE) {
    if (!GCS_BUCKET) {
      throw new GeminiSkippableError(
        `大容量 PDF のため処理をスキップしました (${(buffer.length / 1024 / 1024).toFixed(1)} MB > ${PDF_SAFE_CHUNK_SIZE / 1024 / 1024} MB)。GCS_BUCKET を設定すると処理できます。`
      );
    }
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!);
    const storage = new Storage({ credentials, projectId: PROJECT });
    return extractLargePdf(buffer, storage);
  }

  if (buffer.length <= GEMINI_INLINE_LIMIT) {
    return geminiGenerateContent([
      { inlineData: { mimeType, data: buffer.toString("base64") } },
      { text: OCR_PROMPT },
    ]);
  }

  if (!GCS_BUCKET) {
    throw new GeminiSkippableError(
      `大容量ファイルのため処理をスキップしました (${(buffer.length / 1024 / 1024).toFixed(1)} MB > 20 MB)。GCS_BUCKET を設定すると処理できます。`
    );
  }
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!);
  const storage = new Storage({ credentials, projectId: PROJECT });
  return uploadToGcsAndExtract(storage, buffer, mimeType);
}

function formatDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function buildAnswerRequest(
  question: string,
  contexts: Array<{ file_name: string; content: string; edition: number; drive_created_at?: string | null; drive_modified_at?: string | null }>,
  history: Array<{ role: "user" | "assistant"; content: string }>
) {
  const contextText = contexts
    .map((c, i) => {
      const dateParts: string[] = [];
      if (c.drive_created_at) dateParts.push(`作成: ${formatDate(c.drive_created_at)}`);
      if (c.drive_modified_at) dateParts.push(`更新: ${formatDate(c.drive_modified_at)}`);
      const dateSuffix = dateParts.length > 0 ? `｜${dateParts.join("、")}` : "";
      return `【資料 ${i + 1}: ${c.file_name}（第${c.edition}回）${dateSuffix}】\n${c.content}`;
    })
    .join("\n\n---\n\n");

  const systemInstruction = `あなたは学祭実行委員の資料を熟知した頼れる先輩です。
質問者は「正式名称はわからないけどなんとなくこういうものがあったはず」という曖昧な記憶を手がかりに質問しています。そのような質問者の記憶を呼び起こすきっかけを作ることがあなたの役割です。

【回答の方針】
- 資料から合理的に推測・推論できることは積極的に答えてください。推測の場合は「〜と思われます」「〜が多く見られます」「資料から推測すると〜」のように推測であることがわかる表現を使ってください。
- 正式名称と愛称・略称・通称の対応が文脈から読み取れる場合は、その関係を示してください（例:「大看板」は資料上では「入口看板（大）」と記載されている可能性があります、など）。
- 資料に出てくる人名・役職・担当などのパターンから合理的に判断できることは、推測として答えてください（例:MTに毎回出席している人が担当者である可能性が高い、など）。
- 質問に直接答えるだけでなく、関連しそうな情報や資料も積極的に紹介してください。
- 資料に全く根拠が見当たらない場合のみ「資料には見当たりません」と伝えてください。
- 回答はMarkdown形式で、見出し・箇条書き・表などを適切に使って読みやすく整形してください。
- 前の会話の内容も考慮して回答してください。
- 資料に作成日・更新日が記載されている場合、日付に関する質問には積極的に活用してください。

【参考資料】
${contextText}`;

  const contents = [
    ...history.slice(-6).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: question }] },
  ];

  return { systemInstruction: { parts: [{ text: systemInstruction }] }, contents };
}

type GeminiStreamChunk = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

// バッファから完全な JSON オブジェクト {} を切り出す（複数行 JSON 対応）
function extractObjects(buf: string): { objects: GeminiStreamChunk[]; remaining: string } {
  const objects: GeminiStreamChunk[] = [];
  let i = 0;
  while (i < buf.length) {
    while (i < buf.length && buf[i] !== "{") i++;
    if (i >= buf.length) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    while (j < buf.length) {
      const c = buf[j];
      if (esc) { esc = false; }
      else if (c === "\\" && inStr) { esc = true; }
      else if (c === '"') { inStr = !inStr; }
      else if (!inStr) {
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { break; } }
      }
      j++;
    }
    if (depth !== 0) break; // オブジェクトが未完了 → 残りをバッファへ
    try { objects.push(JSON.parse(buf.slice(i, j + 1)) as GeminiStreamChunk); } catch { /* skip */ }
    i = j + 1;
  }
  return { objects, remaining: buf.slice(i) };
}

export interface QueryExpansion {
  expanded: string;     // ベクトル検索用（同義語補完済み）
  fileKeywords: string; // ファイル名/フォルダ名検索用（AIが重要語のみ抽出）
}

// クエリ展開: 同義語補完 + ファイル検索キーワード抽出を1回のAPI呼び出しで実施
// タイムアウト時は fallback として元の質問を返す
export async function expandQueryTerms(question: string): Promise<QueryExpansion> {
  try {
    const token = await getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    let res: Response;
    try {
      res = await fetch(vertexUrl(CHAT_MODEL, "generateContent"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [{ text: `学祭・イベント運営の文書検索システムです。以下の質問に対して2行だけ出力してください（説明不要）。\n\n1行目: ベクトル検索用クエリ（元の語句＋同義語・別称・略称をスペース区切り）\n2行目: ファイル名/フォルダ名検索用キーワード（資料・組織・場所・活動の固有名詞のみ、スペース区切り。年度数字〈43回など〉・一般疑問詞〈誰/何/どこ〉は除く）\n\n質問: ${question}` }],
          }],
          generationConfig: { maxOutputTokens: 100, temperature: 0 },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { expanded: question, fileKeywords: '' };
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    const lines = text.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
    return {
      expanded: lines[0] || question,
      fileKeywords: lines[1] || '',
    };
  } catch {
    return { expanded: question, fileKeywords: '' };
  }
}

// ストリーミング回答生成（async generator）
export async function* streamGenerateAnswer(
  question: string,
  contexts: Array<{ file_name: string; content: string; edition: number; drive_created_at?: string | null; drive_modified_at?: string | null }>,
  history: Array<{ role: "user" | "assistant"; content: string }> = []
): AsyncGenerator<string> {
  const token = await getAccessToken();
  const body = buildAnswerRequest(question, contexts, history);

  const res = await fetch(vertexUrl(CHAT_MODEL, "streamGenerateContent"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini streaming error ${res.status}: ${err}`);
  }

  if (!res.body) throw new Error("Gemini streaming: response body is null");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let remainder = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      remainder += decoder.decode(value, { stream: true });
      const { objects, remaining } = extractObjects(remainder);
      remainder = remaining;
      for (const obj of objects) {
        const text = obj.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      }
    }
    // ストリーム終了後に残ったバッファを処理
    if (remainder.trim()) {
      const { objects } = extractObjects(remainder);
      for (const obj of objects) {
        const text = obj.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
