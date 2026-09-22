import { NotificationSettings } from "@/components/NotificationSettings";
import Nav from "@/components/Navigation";

export default function NotificationsPage() {
  return (
    <>
      <Nav />
      <main className="px-5 pb-10">
        <NotificationSettings />
      </main>
    </>
  );
}
