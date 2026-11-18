import { currentUser } from "@/lib/auth";
import { SignIn } from "@/components/sign-in";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Sign in first: anonymous visitors get the login screen, members the dashboard. */
export default async function Home() {
  const user = await currentUser();
  if (user) redirect("/dashboard");
  return <SignIn />;
}
