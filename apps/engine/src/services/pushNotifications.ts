import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush, { type PushSubscription } from "web-push";

export interface StoredPushSubscription extends PushSubscription {
  subscribedAt: string;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

export interface PushNotificationStatus {
  configured: boolean;
  subscribed: boolean;
  subscribedAt: string | null;
}

export interface PushSubscriptionStore {
  clear(): Promise<void>;
  read(): Promise<StoredPushSubscription | null>;
  replace(subscription: StoredPushSubscription): Promise<void>;
}

export type PushSender = (
  subscription: PushSubscription,
  payload: string,
  options: {
    TTL: number;
    urgency: "high" | "normal";
    topic: string;
  },
) => Promise<unknown>;

interface PushNotificationServiceOptions {
  privateKey?: string;
  publicKey?: string;
  store: PushSubscriptionStore;
  subject?: string;
  sender?: PushSender;
}

export class FilePushSubscriptionStore implements PushSubscriptionStore {
  constructor(private readonly filePath: string) {}

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }

  async read(): Promise<StoredPushSubscription | null> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const value: unknown = JSON.parse(content);
      return isStoredPushSubscription(value) ? value : null;
    } catch (error: unknown) {
      if (isFileNotFoundError(error)) return null;
      console.error("Failed to read the push subscription store:", error);
      return null;
    }
  }

  async replace(subscription: StoredPushSubscription): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(subscription), "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }
}

export class PushNotificationService {
  private readonly configured: boolean;
  private readonly publicKey: string | null;
  private readonly sender: PushSender;

  constructor({
    privateKey,
    publicKey,
    store,
    subject = "mailto:notifications@example.invalid",
    sender,
  }: PushNotificationServiceOptions) {
    this.store = store;
    this.publicKey = publicKey ?? null;
    this.configured = Boolean(privateKey && publicKey);

    if (this.configured && privateKey && publicKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
    }

    this.sender =
      sender ??
      ((subscription, payload, options) =>
        webpush.sendNotification(subscription, payload, options));
  }

  private readonly store: PushSubscriptionStore;

  getPublicKey(): string | null {
    return this.publicKey;
  }

  async getStatus(): Promise<PushNotificationStatus> {
    const subscription = await this.store.read();
    return {
      configured: this.configured,
      subscribed: subscription !== null,
      subscribedAt: subscription?.subscribedAt ?? null,
    };
  }

  async replaceSubscription(subscription: PushSubscription): Promise<void> {
    if (!isPushSubscription(subscription)) {
      throw new Error("A valid browser push subscription is required.");
    }

    await this.store.replace({
      ...subscription,
      subscribedAt: new Date().toISOString(),
    });
  }

  async removeSubscription(): Promise<void> {
    await this.store.clear();
  }

  async sendTestNotification(): Promise<boolean> {
    return this.send({
      title: "Trading notifications enabled",
      body: "This phone is ready to receive trading alerts.",
      tag: "trading-test",
      url: "/",
    });
  }

  async notifyOrderEvent({
    event,
    fillPrice,
    quantity,
    side,
    strategy,
    symbol,
  }: {
    event: "canceled" | "expired" | "fill" | "partial_fill" | "rejected";
    fillPrice?: number;
    quantity?: number;
    side?: string;
    strategy: string;
    symbol: string;
  }): Promise<boolean> {
    const eventLabel = event.replace("_", " ");
    const action = side ? `${side.toUpperCase()} order` : "Order";
    const executionDetails =
      fillPrice && quantity
        ? ` ${quantity} shares at $${fillPrice.toFixed(2)}.`
        : ".";

    return this.send({
      title: `${symbol} ${eventLabel}`,
      body: `${action} — ${strategy}.${executionDetails}`,
      tag: `order-${symbol}`,
      url: "/logs",
    });
  }

  async notifyRiskEvent({
    reason,
    strategy,
    symbol,
  }: {
    reason: string;
    strategy: string;
    symbol: string;
  }): Promise<boolean> {
    return this.send({
      title: `${symbol} risk exit triggered`,
      body: `${strategy} — ${reason}`,
      tag: `risk-${symbol}`,
      url: "/",
    });
  }

  private async send(payload: PushNotificationPayload): Promise<boolean> {
    if (!this.configured) {
      console.warn(
        "Push notification skipped: VAPID credentials have not been configured.",
      );
      return false;
    }

    const subscription = await this.store.read();
    if (!subscription) return false;

    try {
      await this.sender(subscription, JSON.stringify(payload), {
        TTL: 60 * 5,
        urgency: "high",
        topic: payload.tag.slice(0, 32),
      });
      return true;
    } catch (error: unknown) {
      if (isExpiredSubscriptionError(error)) {
        await this.removeSubscription();
        return false;
      }

      console.error("Failed to send push notification:", error);
      return false;
    }
  }
}

export function createPushNotificationServiceFromEnvironment(): PushNotificationService {
  const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));

  return new PushNotificationService({
    privateKey: process.env.VAPID_PRIVATE_KEY,
    publicKey: process.env.VAPID_PUBLIC_KEY,
    subject: process.env.VAPID_SUBJECT,
    store: new FilePushSubscriptionStore(
      path.resolve(serviceDirectory, "../../data/push-subscription.json"),
    ),
  });
}

export function isPushSubscription(value: unknown): value is PushSubscription {
  if (!isRecord(value) || typeof value.endpoint !== "string") return false;
  if (!value.endpoint.startsWith("https://")) return false;
  if (!isRecord(value.keys)) return false;

  return (
    typeof value.keys.p256dh === "string" &&
    value.keys.p256dh.length > 0 &&
    typeof value.keys.auth === "string" &&
    value.keys.auth.length > 0
  );
}

function isStoredPushSubscription(value: unknown): value is StoredPushSubscription {
  return (
    isPushSubscription(value) &&
    isRecord(value) &&
    typeof value.subscribedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isExpiredSubscriptionError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.statusCode === 404 || error.statusCode === 410)
  );
}
