import { google } from "googleapis";
import { PDFParse } from "pdf-parse";

const EXPORTABLE_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const ALL_MIME_TYPES = new Set([
  ...Object.keys(EXPORTABLE_MIME_TYPES),
  "application/pdf",
  "text/plain",
]);

// SYNC_TYPES 環境変数で対象 MIME タイプを絞り込む
// all (デフォルト) | no-pdf | docs-slides | docs
const SYNC_TYPES_FILTER: Record<string, Set<string>> = {
  all: ALL_MIME_TYPES,
  "no-pdf": new Set([
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.spreadsheet",
    "application/vnd.google-apps.presentation",
    "text/plain",
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

  const exportMime = EXPORTABLE_MIME_TYPES[mimeType];

  if (exportMime) {
    const res = await drive.files.export(
      { fileId, mimeType: exportMime },
      { responseType: "text" }
    );
    return String(res.data);
  }

  // PDF: テキスト抽出
  if (mimeType === "application/pdf") {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const buf = Buffer.from(res.data as ArrayBuffer);
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    return result.text;
  }

  // plain text
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data as ArrayBuffer).toString("utf-8");
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
