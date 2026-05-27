import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listChatSessions } from "@/lib/supabase";

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sessions = await listChatSessions(session.user.email);
  return NextResponse.json(sessions);
}
