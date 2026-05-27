import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import ChatClient from "./ChatClient";
import drives from "../../../config/drives.json";

export default async function ChatPage() {
  const session = await auth();
  if (!session?.user?.email) redirect("/");

  const editions = drives.map((d) => d.edition).sort((a, b) => b - a);

  return (
    <div className="h-screen flex flex-col">
      {/* ログアウトは隠し UI（サイドバーのメールをクリックでも OK） */}
      <div className="absolute top-2 right-3 z-10">
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors px-2 py-1 rounded hover:bg-gray-100"
          >
            ログアウト
          </button>
        </form>
      </div>
      <ChatClient editions={editions} userEmail={session.user.email} />
    </div>
  );
}
