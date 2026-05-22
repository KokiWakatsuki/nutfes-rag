import drives from "../../config/drives.json";
import { listAllFiles, fetchFileContent, chunkText } from "./drive";
import { generateEmbedding } from "./gemini";
import { upsertDocument, getIndexedFileIds } from "./supabase";

export interface SyncResult {
  processed: number;
  skipped: number;
  errors: number;
}

export async function syncAllDrives(): Promise<SyncResult> {
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const { edition, driveId } of drives) {
    console.log(`Syncing drive for edition ${edition}: ${driveId}`);
    const result = await syncDrive(driveId, edition);
    processed += result.processed;
    skipped += result.skipped;
    errors += result.errors;
  }

  return { processed, skipped, errors };
}

async function syncDrive(
  driveId: string,
  edition: number
): Promise<SyncResult> {
  const files = await listAllFiles(driveId);
  const indexedIds = new Set(await getIndexedFileIds(driveId));

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    if (indexedIds.has(file.id)) {
      skipped++;
      continue;
    }

    try {
      const content = await fetchFileContent(file.id, file.mimeType);
      if (!content.trim()) {
        skipped++;
        continue;
      }

      const chunks = chunkText(content);
      for (const chunk of chunks) {
        const embedding = await generateEmbedding(chunk);
        await upsertDocument({
          file_id: file.id,
          file_name: file.name,
          content: chunk,
          edition,
          drive_id: driveId,
          embedding,
        });
      }

      processed++;
      console.log(`  ✓ ${file.name}`);
    } catch (err) {
      console.error(`  ✗ ${file.name}:`, err);
      errors++;
    }
  }

  return { processed, skipped, errors };
}
