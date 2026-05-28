import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import ChatClient from "./ChatClient";
import drives from "../../../config/drives.json";

export default async function ChatPage() {
  const session = await auth();
  if (!session?.user?.email) redirect("/");

  const editions = drives.map((d) => d.edition).sort((a, b) => b - a);

  const logoutAction = async () => {
    "use server";
    await signOut({ redirectTo: "/" });
  };

  return (
    <ChatClient editions={editions} userEmail={session.user.email} logoutAction={logoutAction} />
  );
}
