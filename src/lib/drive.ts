import { google } from "googleapis";
import { PDFParse } from "pdf-parse";
import { extractFileContent as geminiExtract, GeminiSkippableError } from "./gemini";
import officeParser from "officeparser";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Google Workspace → Drive export API
const EXPORTABLE_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

// MIME タイプ → 拡張子マッピング（officeparser の一時ファイル処理用）
const MIME_TO_EXT: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
};

// officeparser でテキスト抽出する Office ファイル種別（Vertex AI 非対応）
const OFFICE_EXTRACT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

// Gemini でテキスト抽出するファイル種別（PDF・画像のみ）
export const GEMINI_EXTRACT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
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
  ...OFFICE_EXTRACT_TYPES,
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

let _driveAuth: InstanceType<typeof google.auth.GoogleAuth> | null = null;

function getAuthClient() {
  if (!_driveAuth) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!);
    _driveAuth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
  }
  return _driveAuth;
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
  const enabledTypes = getEnabledMimeTypes();

  // Shared Drive ID かどうかを確認し、一括取得を試みる
  try {
    await drive.drives.get({ driveId: folderId });
    // Shared Drive ID が確認できた → driveId 指定で全件フラット取得
    return await listAllFilesFlat(drive, folderId, enabledTypes);
  } catch {
    // Shared Drive ID ではない（サブフォルダ等）→ 並列再帰にフォールバック
    process.stdout.write("  サブフォルダ指定のため並列再帰探索を使用\n");
    return await listAllFilesParallel(drive, folderId, enabledTypes);
  }
}

// Shared Drive 全体を一括取得（フォルダ再帰不要）
async function listAllFilesFlat(
  drive: ReturnType<typeof google.drive>,
  driveId: string,
  enabledTypes: Set<string>
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  let page = 0;

  do {
    const res = await drive.files.list({
      corpora: "drive",
      driveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
      pageSize: 1000,
      pageToken,
    });

    page++;
    for (const f of res.data.files ?? []) {
      if (!f.id || !f.name || !f.mimeType) continue;
      if (enabledTypes.has(f.mimeType)) {
        files.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modifiedTime: f.modifiedTime ?? "",
        });
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
    process.stdout.write(`  ページ ${page} 取得完了: 計 ${files.length} 件\n`);
  } while (pageToken);

  return files;
}

// フォルダIDが Shared Drive ルートでない場合の並列再帰探索
async function listAllFilesParallel(
  drive: ReturnType<typeof google.drive>,
  rootId: string,
  enabledTypes: Set<string>
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  const folderQueue: string[] = [rootId];
  let folderCount = 0;
  const FOLDER_CONCURRENCY = 20;

  async function processQueue() {
    while (folderQueue.length > 0) {
      const parentId = folderQueue.shift();
      if (!parentId) continue;
      folderCount++;
      if (folderCount % 20 === 0) {
        process.stdout.write(`  フォルダ探索中: ${folderCount} フォルダ目, ファイル ${files.length} 件\n`);
      }

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
            folderQueue.push(f.id);
          } else if (enabledTypes.has(f.mimeType)) {
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
  }

  // キューが空になるまで並列ワーカーで消化（先に追加されたフォルダを随時処理）
  // 単純な Promise.all では動的追加に対応できないため、ポーリング方式で制御
  const workers = Array.from({ length: FOLDER_CONCURRENCY }, () => processQueue());
  await Promise.all(workers);

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

  // Office ファイル → officeparser でテキスト抽出（Vertex AI は非対応）
  if (OFFICE_EXTRACT_TYPES.has(mimeType)) {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const buf = Buffer.from(res.data as ArrayBuffer);
    // officeparser はバッファのみでは形式を判別できない場合があるため
    // 拡張子付きの一時ファイルに書き出して処理する
    const ext = MIME_TO_EXT[mimeType] ?? "bin";
    const tmpPath = join(tmpdir(), `office-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    writeFileSync(tmpPath, buf);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return String((await (officeParser as any).parseOffice(tmpPath)) ?? "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // officeparser が未対応の形式（.ppt/.doc/.xls など）は永続的エラー → スキップ
      if (msg.includes("[OfficeParser]:")) {
        throw new GeminiSkippableError(`OfficeParser unsupported: ${msg.slice(0, 120)}`);
      }
      throw err;
    } finally {
      unlinkSync(tmpPath);
    }
  }

  // PDF・画像 → バイナリダウンロード後に処理
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
      } catch (_err) {
        // pdf-parse 失敗（Unicode エラー等）→ Gemini OCR にフォールバック
      }
    }

    // スキャンPDF・画像: Gemini Flash でテキスト抽出
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
