"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

interface NotificationStatus {
  configured: boolean;
  subscribed: boolean;
  subscribedAt: string | null;
}

const NOTIFICATION_API_URL = "/api/notifications";

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }

  return output;
}

export function NotificationSettings() {
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [browserSubscription, setBrowserSubscription] =
    useState<PushSubscription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("Checking notification status…");
  const [isWorking, setIsWorking] = useState(false);

  const isSupported = useSyncExternalStore(
    subscribeToBrowserSupport,
    browserSupportsPush,
    () => false,
  );

  const initialize = useCallback(async (): Promise<void> => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
      const subscription = await registration.pushManager.getSubscription();
      setBrowserSubscription(subscription);

      const response = await fetch(`${NOTIFICATION_API_URL}/status`);
      if (!response.ok) {
        throw new Error("The trading engine could not provide notification status.");
      }

      const latestStatus = (await response.json()) as NotificationStatus;
      setStatus(latestStatus);
      setMessage(
        subscription && latestStatus.subscribed
          ? "This phone is registered for trading alerts."
          : "Notifications are not enabled on this phone.",
      );
    } catch (caughtError: unknown) {
      setError(messageForError(caughtError));
      setMessage("Could not connect to the trading engine.");
    }
  }, []);

  useEffect(() => {
    if (!isSupported) return;

    const timer = window.setTimeout(() => {
      void initialize();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [initialize, isSupported]);

  async function enableNotifications(): Promise<void> {
    if (!isSupported) return;

    setIsWorking(true);
    setError(null);

    try {
      const response = await fetch(`${NOTIFICATION_API_URL}/vapid-public-key`);
      if (!response.ok) {
        throw new Error("Push notifications have not been configured on the trading engine.");
      }

      const { publicKey } = (await response.json()) as { publicKey: string };
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMessage("Permission was not granted. Enable notifications in your browser settings to try again.");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const subscriptionResponse = await fetch(
        `${NOTIFICATION_API_URL}/subscription`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subscription.toJSON()),
        },
      );
      if (!subscriptionResponse.ok) {
        throw new Error("The trading engine could not save this phone.");
      }

      setBrowserSubscription(subscription);
      setStatus((current) => ({
        configured: current?.configured ?? true,
        subscribed: true,
        subscribedAt: new Date().toISOString(),
      }));
      setMessage("Notifications are enabled for this phone.");
    } catch (caughtError: unknown) {
      setError(messageForError(caughtError));
    } finally {
      setIsWorking(false);
    }
  }

  async function disableNotifications(): Promise<void> {
    setIsWorking(true);
    setError(null);

    try {
      await browserSubscription?.unsubscribe();
      const response = await fetch(`${NOTIFICATION_API_URL}/subscription`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("The trading engine could not remove this phone.");
      }

      setBrowserSubscription(null);
      setStatus((current) => ({
        configured: current?.configured ?? false,
        subscribed: false,
        subscribedAt: null,
      }));
      setMessage("Notifications are disabled for this phone.");
    } catch (caughtError: unknown) {
      setError(messageForError(caughtError));
    } finally {
      setIsWorking(false);
    }
  }

  async function sendTestNotification(): Promise<void> {
    setIsWorking(true);
    setError(null);

    try {
      const response = await fetch(`${NOTIFICATION_API_URL}/test`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("The test notification could not be sent.");
      }
      setMessage("Test notification sent.");
    } catch (caughtError: unknown) {
      setError(messageForError(caughtError));
    } finally {
      setIsWorking(false);
    }
  }

  const isEnabled = Boolean(
    browserSubscription && status?.configured && status.subscribed,
  );

  return (
    <section className="mx-auto mt-10 max-w-xl rounded-lg border border-slate-700 bg-slate-900 p-6 shadow-lg">
      <h1 className="text-xl font-semibold">Notification settings</h1>
      <p className="mt-2 text-sm text-slate-300">
        This dashboard sends trading alerts to one registered phone. Enabling alerts on this device replaces the previous phone.
      </p>

      <div className="mt-6 rounded-md bg-slate-800 px-4 py-3 text-sm" aria-live="polite">
        <p className="font-medium">{isEnabled ? "Enabled" : "Not enabled"}</p>
        <p className="mt-1 text-slate-300">
          {isSupported ? message : "Push notifications are not supported in this browser."}
        </p>
      </div>

      {!status?.configured && !error ? (
        <p className="mt-4 text-sm text-amber-300">
          The trading engine needs VAPID credentials before notifications can be enabled.
        </p>
      ) : null}

      {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}

      <div className="mt-6 flex flex-wrap gap-3">
        {isEnabled ? (
          <>
            <button
              className="rounded-md bg-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isWorking}
              onClick={() => void sendTestNotification()}
              type="button"
            >
              Send test
            </button>
            <button
              className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isWorking}
              onClick={() => void disableNotifications()}
              type="button"
            >
              Disable
            </button>
          </>
        ) : (
          <button
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isWorking || !isSupported || status?.configured === false}
            onClick={() => void enableNotifications()}
            type="button"
          >
            Enable notifications
          </button>
        )}
      </div>

      <p className="mt-6 text-xs text-slate-400">
        On iPhone, first add this dashboard to the Home Screen in Safari, then open the installed app and enable notifications.
      </p>
    </section>
  );
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function subscribeToBrowserSupport(): () => void {
  return () => undefined;
}

function browserSupportsPush(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}
