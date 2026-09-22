self.addEventListener("push", (event) => {
  const fallback = {
    title: "Trading alert",
    body: "Open the dashboard to view the latest trading update.",
    tag: "trading-alert",
    url: "/",
  };

  let payload = fallback;
  try {
    payload = { ...fallback, ...event.data?.json() };
  } catch {
    // A malformed payload should still create a visible notification.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      badge: "/favicon.ico",
      icon: "/favicon.ico",
      tag: payload.tag,
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url ?? "/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === targetUrl && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
