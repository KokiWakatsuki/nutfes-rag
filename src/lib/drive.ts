import { google } from "googleapis";
import { PDFParse } from "pdf-parse";
import { extractFileContent as geminiExtract } from "./gemini";

// Google Workspace → Drive export API
const EXPORTABLE_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

// Gemini でテキスト抽出するファイル種別（スキャンPDF含む）
export const GEMINI_EXTRACT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

// 直接ダウンロードできるテキスト系ファイル
const TEXT_DOWNLOAD_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/html",
  "text/markdown",
  "application/json",
]);

// 全対応 MIME タイプ
export const ALL_MIME_TYPES = new Set([
  ...Object.keys(EXPORTABLE_MIME_TYPES),
  ...GEMINI_EXTRACT_TYPES,
  ...TEXT_DOWNLOAD_TYPES,
]);

// テキストPDFか判定する最小文字数（これ未満ならスキャンPDFとして Gemini に渡す）
const MIN_PDF_TEXT_CHARS = 100;

// SYNC_TYPES 環境変数で対象を絞り込む
// all (デフォルト) | no-pdf | docs-slides | docs
const SYNC_TYPES_FILTER: Record<string, Set<string>> = {
  all: ALL_MIME_TYPES,
  "no-pdf": new Set([
    ...Object.keys(EXPORTABLE_MIME_TYPES),
    ...TEXT_DOWNLOAD_TYPES,
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
  ]),
  "docs-slides": new Set([
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.presentation",
  ]),
  docs: new Set(["application/vnd.google-apps.document"]),
};

function getEnabledMimeTypes(): Set<string> {
  const key = (process.env.SYNC_TYPES ?? "all").toLowerCase();
  return SYNC_TYPES_FILTER[key] ?? ALL_MIME_TYPES;
}

function getAuthClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY!;
  const credentials = JSON.parse(keyJson);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

export async function listAllFiles(folderId: string): Promise<DriveFile[]> {
  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });
  const files: DriveFile[] = [];

  async function listFolder(parentId: string) {
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${parentId}' in parents and trashed = false`,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
        pageToken,
        pageSize: 1000,
      });

      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name || !f.mimeType) continue;
        if (f.mimeType === "application/vnd.google-apps.folder") {
          await listFolder(f.id);
        } else if (getEnabledMimeTypes().has(f.mimeType)) {
          files.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            modifiedTime: f.modifiedTime ?? "",
          });
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  await listFolder(folderId);
  return files;
}

export async function fetchFileContent(
  fileId: string,
  mimeType: string
): Promise<string> {
  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });

  // Google Workspace → Drive export API（テキスト変換はGoogleが行う）
  const exportMime = EXPORTABLE_MIME_TYPES[mimeType];
  if (exportMime) {
    const res = await drive.files.export(
      { fileId, mimeType: exportMime },
      { responseType: "text" }
    );
    return String(res.data);
  }

  // テキスト系 → 直接ダウンロード
  if (TEXT_DOWNLOAD_TYPES.has(mimeType)) {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data as ArrayBuffer).toString("utf-8");
  }

  // バイナリ系（PDF・画像・Office）→ バイナリダウンロード後に処理
  if (GEMINI_EXTRACT_TYPES.has(mimeType)) {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const buf = Buffer.from(res.data as ArrayBuffer);

    // テキストPDF: pdf-parse で高速処理（APIコスト不要）
    if (mimeType === "application/pdf") {
      try {
        const parser = new PDFParse({ data: buf });
        const result = await parser.getText();
        if (result.text.trim().length >= MIN_PDF_TEXT_CHARS) {
          return result.text;
        }
        // テキストが少ない → スキャンPDFとして Gemini に渡す
      } catch {
        // pdf-parse 失敗 → Gemini にフォールバック
      }
    }

    // スキャンPDF・画像・Office: Gemini Flash でテキスト抽出
    return await geminiExtract(buf, mimeType);
  }

  throw new Error(`未対応のファイル形式: ${mimeType}`);
}

export function chunkText(text: string, maxChars = 3000): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += trimmed + "\n\n";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
