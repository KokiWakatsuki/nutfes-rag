import drives from "../../config/drives.json";
import { listAllFiles, fetchFileContent, chunkText } from "./drive";
import { generateEmbeddingBatch } from "./gemini";
import { upsertDocument, getIndexedFileIds } from "./supabase";

export interface SyncResult {
  processed: number;
  skipped: number;
  empty: number;
  errors: number;
}

const CONCURRENCY = 5;
const EMBED_BATCH_SIZE = 5;
// text-embedding-004: 20,000 tokens/request 上限
// 3000文字×5チャンク ≈ 5,000〜10,000 tokens で安全に収まる
const EMBED_INTERVAL_MS = 700;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Vertex AI 429 の種別を判定
// "daily quota exhausted" → true（abort）
// "rate limit / resource exhausted" → false（リトライ可）
function isDailyQuotaExhausted(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("daily limit") ||
    lower.includes("quota exceeded") ||
    lower.includes("insufficient_quota") ||
    (lower.includes("quota") && !lower.includes("resource exhausted") && !lower.includes("try again"))
  );
}

export async function syncAllDrives(): Promise<SyncResult> {
  let processed = 0;
  let skipped = 0;
  let empty = 0;
  let errors = 0;

  const syncTypes = process.env.SYNC_TYPES ?? "all";
  const typeLabels: Record<string, string> = {
    all: "全種別（PDF 含む）",
    "no-pdf": "PDF を除外",
    "docs-slides": "ドキュメント・スライドのみ",
    docs: "ドキュメントのみ",
  };
  console.log(`対象種別: ${typeLabels[syncTypes] ?? syncTypes} (SYNC_TYPES=${syncTypes})`);

  for (const { edition, driveId } of drives) {
    console.log(`\n=== 第${edition}回 (${driveId}) ===`);
    const result = await syncDrive(driveId, edition);
    processed += result.processed;
    skipped += result.skipped;
    empty += result.empty;
    errors += result.errors;
  }

  return { processed, skipped, empty, errors };
}

async function syncDrive(
  driveId: string,
  edition: number
): Promise<SyncResult> {
  console.log("ファイル一覧を取得中...");
  const files = await listAllFiles(driveId);
  const indexedIds = new Set(await getIndexedFileIds(driveId));

  const newFiles = files.filter((f) => !indexedIds.has(f.id));
  console.log(
    `合計 ${files.length} 件 / 未処理 ${newFiles.length} 件 / スキップ ${files.length - newFiles.length} 件`
  );

  let processed = 0;
  let empty = 0;
  let errors = 0;
  let embedCallCount = 0;
  let nextIdx = 0;
  let aborted = false;
  let firstFile = true;

  async function worker() {
    while (!aborted) {
      const i = nextIdx++;
      if (i >= newFiles.length) break;

      const file = newFiles[i];
      const progress = `[${i + 1}/${newFiles.length}]`;

      try {
        let raw: string | undefined;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            raw = await fetchFileContent(file.id, file.mimeType);
            break;
          } catch (retryErr: unknown) {
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            const isNetworkTransient = msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ENOTFOUND") || msg.includes("fetch failed");
            const isRateLimit = (msg.includes("429") || msg.toLowerCase().includes("resource exhausted")) && !isDailyQuotaExhausted(msg);

            if ((isNetworkTransient || isRateLimit) && attempt < 3) {
              const waitMs = isRateLimit ? 60000 : 3000 * (attempt + 1);
              console.warn(`${progress} リトライ ${attempt + 1}/3 (${isRateLimit ? "レート制限" : "一時障害"}, ${waitMs / 1000}秒待機): ${file.name}`);
              await sleep(waitMs);
              continue;
            }
            throw retryErr;
          }
        }
        const content = raw!.replace(/\x00/g, ""); // eslint-disable-line no-control-regex

        if (!content.trim()) {
          console.log(`${progress} スキップ（空）: ${file.name}`);
          empty++;
          continue;
        }

        const chunks = chunkText(content);
        const embeddings: number[][] = [];

        for (let b = 0; b < chunks.length; b += EMBED_BATCH_SIZE) {
          await sleep(EMBED_INTERVAL_MS);
          embedCallCount++;

          if (embedCallCount === 1400) {
            console.warn(
              "⚠️  Embedding API 呼び出しが 1400 回に達しました。上限まで残り少ないです。"
            );
          }

          const batch = chunks.slice(b, b + EMBED_BATCH_SIZE);
          const batchEmbeddings = await generateEmbeddingBatch(batch);

          if (firstFile && b === 0) {
            console.log(`  埋め込み次元数: ${batchEmbeddings[0]?.length ?? "不明"}`);
            firstFile = false;
          }

          embeddings.push(...batchEmbeddings);
        }

        for (let j = 0; j < chunks.length; j++) {
          await upsertDocument({
            file_id: file.id,
            chunk_index: j,
            file_name: file.name,
            content: chunks[j],
            edition,
            drive_id: driveId,
            embedding: embeddings[j],
          });
        }

        processed++;
        console.log(`${progress} ✓ ${file.name} (${chunks.length} チャンク)`);
      } catch (err: unknown) {
        const msg = err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? String(err);

        console.error(`${progress} ✗ ${file.name}: ${msg}`);
        console.error(`   RAW ERROR:`, JSON.stringify(err, Object.getOwnPropertyNames(err instanceof Error ? err : Object(err))));

        // 日次クォータ超過のみ致命的エラーとして全ワーカーを停止
        if (isDailyQuotaExhausted(msg)) {
          console.error(
            `\n❌ API の1日の上限に達しました。明日以降に再実行してください。`
          );
          console.error(`   中断時点: ${i + 1}/${newFiles.length} 件処理済み`);
          aborted = true;
          break;
        }
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`  → 処理済み ${processed} / 空 ${empty} / エラー ${errors} / スキップ（DB済み） ${files.length - newFiles.length}`);
  return {
    processed,
    skipped: files.length - newFiles.length,
    empty,
    errors,
  };
}
