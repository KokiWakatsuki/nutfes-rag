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
  drive_modified_at?: string;
  drive_created_at?: string;
  embedding?: number[];
  created_at: string;
  updated_at: string;
}

export interface ChatSession {
  id: string;
  user_email: string;
  title: string;
  editions: number[] | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  sources: Array<{ fileName: string; edition: number }>;
  created_at: string;
}

// --- Documents ---

export async function searchDocuments(
  queryEmbedding: number[],
  editions: number[] | null,
  limit = 8,
  queryText?: string
): Promise<Document[]> {
  const params: Record<string, unknown> = {
    query_embedding: queryEmbedding,
    match_count: limit,
    filter_editions: editions,
  };
  if (queryText && queryText.trim().length >= 2) {
    // 全角スペースなどを正規化
    let q = queryText.trim().replace(/[\s　 ]+/g, ' ');
    // スペースがない（= expandQueryTerms が元の質問を返した）場合、
    // 日本語の助詞・句読点で区切ってキーワードを抽出する
    if (!q.includes(' ') && q.length > 4) {
      q = q
        .replace(/[のはがをにでもとかなやねよてへからまでよりなどって。、！？…「」【】（）：；・～]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (q.length >= 2) params.query_text = q;
  }
  const { data, error } = await getSupabase().rpc("match_documents", params);
  if (error) throw error;
  return data ?? [];
}

// maxChunkIndex より大きいインデックスのチャンクを削除（ファイル縮小時のゴミ防止）
export async function deleteStaleChunks(fileId: string, maxChunkIndex: number): Promise<void> {
  const { error } = await getSupabase()
    .from("documents")
    .delete()
    .eq("file_id", fileId)
    .gt("chunk_index", maxChunkIndex);
  if (error) throw error;
}

export async function upsertDocument(doc: {
  file_id: string;
  chunk_index: number;
  file_name: string;
  content: string;
  edition: number;
  drive_id: string;
  drive_modified_at?: string;
  drive_created_at?: string;
  embedding: number[];
}): Promise<void> {
  const { error } = await getSupabase()
    .from("documents")
    .upsert({ ...doc, updated_at: new Date().toISOString() }, { onConflict: "file_id,chunk_index" });
  if (error) throw error;
}


// グローバルレート制限（全 Vercel インスタンス間で共有、アトミック）
// TRUE = 許可 / FALSE = 制限中
export async function checkRateLimit(
  email: string,
  maxPerMinute = 20
): Promise<boolean> {
  const { data, error } = await getSupabase().rpc("check_rate_limit", {
    p_email: email,
    p_max_requests: maxPerMinute,
    p_window_ms: 60_000,
  });
  if (error) {
    // RPC失敗時はリクエストを通す（誤ブロックによるユーザー影響を防ぐ）
    console.error("Rate limit check failed:", error.message);
    return true;
  }
  return data === true;
}

// file_id → drive_modified_at (null if unknown) のマップを返す
export async function getIndexedFiles(driveId: string): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const PAGE_SIZE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await getSupabase()
      .from("documents")
      .select("file_id, drive_modified_at")
      .eq("drive_id", driveId)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (!result.has(r.file_id)) {
        result.set(r.file_id, r.drive_modified_at ?? null);
      }
    }
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return result;
}

// --- Chat Sessions ---

export async function createChatSession(
  userEmail: string,
  title: string,
  editions: number[] | null
): Promise<ChatSession> {
  const { data, error } = await getSupabase()
    .from("chat_sessions")
    .insert({ user_email: userEmail, title, editions })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listChatSessions(userEmail: string): Promise<ChatSession[]> {
  const { data, error } = await getSupabase()
    .from("chat_sessions")
    .select("id, title, editions, created_at, updated_at")
    .eq("user_email", userEmail)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as ChatSession[];
}

export async function getChatSession(
  sessionId: string,
  userEmail: string
): Promise<{ session: ChatSession; messages: ChatMessage[] } | null> {
  const { data: session, error: sessionError } = await getSupabase()
    .from("chat_sessions")
    .select()
    .eq("id", sessionId)
    .eq("user_email", userEmail)
    .single();
  if (sessionError || !session) return null;

  const { data: messages, error: msgError } = await getSupabase()
    .from("chat_messages")
    .select()
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (msgError) throw msgError;

  return { session, messages: messages ?? [] };
}

export async function deleteChatSession(sessionId: string, userEmail: string): Promise<void> {
  const { error } = await getSupabase()
    .from("chat_sessions")
    .delete()
    .eq("id", sessionId)
    .eq("user_email", userEmail);
  if (error) throw error;
}

export async function renameChatSession(
  sessionId: string,
  userEmail: string,
  title: string
): Promise<void> {
  const { error } = await getSupabase()
    .from("chat_sessions")
    .update({ title })
    .eq("id", sessionId)
    .eq("user_email", userEmail);
  if (error) throw error;
}

export async function touchChatSession(sessionId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("chat_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) throw error;
}

// --- Chat Messages ---

export async function saveChatMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  sources: Array<{ fileName: string; edition: number }>
): Promise<void> {
  const { error } = await getSupabase()
    .from("chat_messages")
    .insert({ session_id: sessionId, role, content, sources });
  if (error) throw error;
}
