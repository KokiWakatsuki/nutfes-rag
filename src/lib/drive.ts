import { google } from "googleapis";
import { PDFParse } from "pdf-parse";
import { extractFileContent as geminiExtract, GeminiSkippableError } from "./gemini";
import { chunkText } from "./text";
import officeParser from "officeparser";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

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

// 旧 Office 形式 → モダン形式 変換マップ（LibreOffice で変換してから officeparser）
const LEGACY_TO_MODERN: Record<string, string> = { doc: "docx", xls: "xlsx", ppt: "pptx" };

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

// 画像リサイズ閾値: これより大きい画像は 2048px に縮小して Gemini に渡す
const IMAGE_RESIZE_THRESHOLD = 3 * 1024 * 1024;
const IMAGE_MAX_DIM = 2048;

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

// HEIC/HEIF → JPEG 変換 + 大サイズ画像リサイズ（Gemini OCR タイムアウト防止）
async function normalizeImage(buf: Buffer, mimeType: string): Promise<{ buf: Buffer; mimeType: string }> {
  if (mimeType === "image/heic" || mimeType === "image/heif") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const heicConvertModule = require("heic-convert");
    const heicConvert: (opts: { buffer: Buffer; format: "JPEG"; quality: number }) => Promise<ArrayBuffer> =
      heicConvertModule.default ?? heicConvertModule;
    const converted = await heicConvert({ buffer: buf, format: "JPEG", quality: 0.9 });
    buf = Buffer.from(converted);
    mimeType = "image/jpeg";
  }
  if (buf.length > IMAGE_RESIZE_THRESHOLD) {
    buf = await sharp(buf)
      .rotate()
      .resize(IMAGE_MAX_DIM, IMAGE_MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    mimeType = "image/jpeg";
  }
  return { buf, mimeType };
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

async function fetchFileContentImpl(
  fileId: string,
  mimeType: string
): Promise<string> {
  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });

  // Google Workspace → Drive export API（テキスト変換はGoogleが行う）
  const exportMime = EXPORTABLE_MIME_TYPES[mimeType];
  if (exportMime) {
    try {
      const res = await drive.files.export(
        { fileId, mimeType: exportMime },
        { responseType: "text" }
      );
      return String(res.data);
    } catch (exportErr: unknown) {
      const msg = exportErr instanceof Error ? exportErr.message : String(exportErr);
      const isTransient = msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ENOTFOUND") || msg.includes("fetch failed");
      if (isTransient) throw exportErr;
      throw new GeminiSkippableError(`Driveエクスポート失敗: ${msg.slice(0, 120)}`);
    }
  }

  // テキスト系 → 直接ダウンロード
  if (TEXT_DOWNLOAD_TYPES.has(mimeType)) {
    try {
      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
      );
      return Buffer.from(res.data as ArrayBuffer).toString("utf-8");
    } catch (downloadErr: unknown) {
      const msg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
      const isTransient = msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ENOTFOUND") || msg.includes("fetch failed");
      if (isTransient) throw downloadErr;
      throw new GeminiSkippableError(`Driveダウンロード失敗: ${msg.slice(0, 120)}`);
    }
  }

  // Office ファイル → officeparser でテキスト抽出
  if (OFFICE_EXTRACT_TYPES.has(mimeType)) {
    let buf: Buffer;
    try {
      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
      );
      buf = Buffer.from(res.data as ArrayBuffer);
    } catch (downloadErr: unknown) {
      const msg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
      const isTransient = msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ENOTFOUND") || msg.includes("fetch failed");
      if (isTransient) throw downloadErr;
      throw new GeminiSkippableError(`Driveダウンロード失敗: ${msg.slice(0, 120)}`);
    }
    const ext = MIME_TO_EXT[mimeType] ?? "bin";
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpPath = join(tmpdir(), `office-${uid}.${ext}`);
    writeFileSync(tmpPath, buf);

    const modernExt = LEGACY_TO_MODERN[ext];
    try {
      if (modernExt) {
        // .ppt/.doc/.xls などの旧形式: LibreOffice で .pptx/.docx/.xlsx に変換してから処理
        // -env:UserInstallation で並列実行時のプロファイル競合を回避
        try {
          await execFileAsync("libreoffice", [
            "--headless",
            `-env:UserInstallation=file:///tmp/lo-${uid}`,
            "--convert-to", modernExt,
            "--outdir", tmpdir(),
            tmpPath,
          ], { timeout: 60_000 });
        } catch (libreErr) {
          const msg = libreErr instanceof Error ? libreErr.message : String(libreErr);
          throw new GeminiSkippableError(`LibreOffice変換失敗: ${msg.slice(0, 120)}`);
        }
        const convertedPath = join(tmpdir(), `${basename(tmpPath, `.${ext}`)}.${modernExt}`);
        if (!existsSync(convertedPath)) {
          throw new GeminiSkippableError(`LibreOffice変換後ファイルが見つかりません: ${convertedPath}`);
        }
        try {
          // officeparser v7+ は AST オブジェクトを返す（v6 以前は文字列）
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ast = await (officeParser as any).parseOffice(convertedPath);
          return typeof ast?.toText === "function" ? (ast.toText() ?? "") : String(ast ?? "");
        } catch (parseErr) {
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          throw new GeminiSkippableError(`変換後のOfficeファイル解析失敗: ${msg.slice(0, 120)}`);
        } finally {
          try { unlinkSync(convertedPath); } catch {}
        }
      }
      // officeparser v7+ は AST オブジェクトを返す（v6 以前は文字列）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ast = await (officeParser as any).parseOffice(tmpPath);
      return typeof ast?.toText === "function" ? (ast.toText() ?? "") : String(ast ?? "");
    } catch (err) {
      if (err instanceof GeminiSkippableError) throw err;
      // officeparser が破損ファイルや非対応形式でエラーを投げた場合は永続的スキップ
      const msg = err instanceof Error ? err.message : String(err);
      throw new GeminiSkippableError(`Officeファイル解析失敗: ${msg.slice(0, 120)}`);
    } finally {
      try { unlinkSync(tmpPath); } catch {}
    }
  }

  // PDF・画像 → バイナリダウンロード後に処理
  if (GEMINI_EXTRACT_TYPES.has(mimeType)) {
    let buf: Buffer;
    try {
      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
      );
      buf = Buffer.from(res.data as ArrayBuffer);
    } catch (downloadErr: unknown) {
      const msg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
      const isTransient = msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ENOTFOUND") || msg.includes("fetch failed");
      if (isTransient) throw downloadErr;
      throw new GeminiSkippableError(`Driveダウンロード失敗: ${msg.slice(0, 120)}`);
    }

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

    // 画像: HEIC→JPEG 変換 + 大サイズリサイズ（タイムアウト防止）
    let effectiveMimeType = mimeType;
    if (mimeType !== "application/pdf") {
      try {
        const normalized = await normalizeImage(buf, mimeType);
        buf = Buffer.from(normalized.buf);
        effectiveMimeType = normalized.mimeType;
      } catch (_normalizeErr) {
        // sharp/heic-convert 失敗（破損画像等）→ 元バッファのままフォールバック
      }
    }

    // スキャンPDF・画像: Gemini Flash でテキスト抽出
    return await geminiExtract(buf, effectiveMimeType);
  }

  throw new GeminiSkippableError(`未対応のファイル形式: ${mimeType}`);
}

// 外側ラッパー: fetchFileContentImpl から漏れた全エラーをネットワーク系以外は GeminiSkippableError に変換
export async function fetchFileContent(
  fileId: string,
  mimeType: string
): Promise<string> {
  try {
    return await fetchFileContentImpl(fileId, mimeType);
  } catch (err) {
    const errName = (err as Error)?.name;
    const msg = err instanceof Error ? err.message : String(err);
    const isSkippable = err instanceof GeminiSkippableError || errName === "GeminiSkippableError";
    if (isSkippable) throw err;
    const isTransient = msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ENOTFOUND") || msg.includes("fetch failed");
    if (isTransient) throw err;
    throw new GeminiSkippableError(`ファイル処理失敗: ${msg.slice(0, 120)}`);
  }
}

export { chunkText } from "./text";
