import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!
    );
  }
  return _supabase;
}

export interface Document {
  id: string;
  file_id: string;
  file_name: string;
  content: string;
  edition: number;
  drive_id: string;
  embedding?: number[];
  created_at: string;
  updated_at: string;
}

export async function searchDocuments(
  queryEmbedding: number[],
  edition: number | null,
  limit = 5
): Promise<Document[]> {
  const { data, error } = await getSupabase().rpc("match_documents", {
    query_embedding: queryEmbedding,
    match_count: limit,
    filter_edition: edition,
  });
  if (error) throw error;
  return data ?? [];
}

export async function upsertDocument(doc: {
  file_id: string;
  file_name: string;
  content: string;
  edition: number;
  drive_id: string;
  embedding: number[];
}): Promise<void> {
  const { error } = await getSupabase()
    .from("documents")
    .upsert({ ...doc, updated_at: new Date().toISOString() }, { onConflict: "file_id" });
  if (error) throw error;
}

export async function deleteDocumentsByDriveId(driveId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("documents")
    .delete()
    .eq("drive_id", driveId);
  if (error) throw error;
}

export async function getIndexedFileIds(driveId: string): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from("documents")
    .select("file_id")
    .eq("drive_id", driveId);
  if (error) throw error;
  return (data ?? []).map((r) => r.file_id);
}
