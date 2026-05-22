import { google } from "googleapis";

const EXPORTABLE_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const SUPPORTED_MIME_TYPES = new Set([
  ...Object.keys(EXPORTABLE_MIME_TYPES),
  "application/pdf",
  "text/plain",
]);

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
        } else if (SUPPORTED_MIME_TYPES.has(f.mimeType)) {
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

  // binary download (PDF, plain text)
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const buf = Buffer.from(res.data as ArrayBuffer);
  return buf.toString("utf-8");
}

export function chunkText(text: string, maxChars = 2000): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += para + "\n\n";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
