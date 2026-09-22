import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import webpush from "web-push";

import {
  FilePushSubscriptionStore,
  type PushSender,
  type PushSubscriptionStore,
  PushNotificationService,
  type StoredPushSubscription,
} from "./pushNotifications.js";

const subscription: StoredPushSubscription = {
  endpoint: "https://push.example.test/subscription",
  expirationTime: null,
  keys: {
    p256dh: "test-public-key",
    auth: "test-auth-secret",
  },
  subscribedAt: "2026-09-22T15:00:00.000Z",
};
const vapidKeys = webpush.generateVAPIDKeys();

class MemoryPushSubscriptionStore implements PushSubscriptionStore {
  public current: StoredPushSubscription | null = null;

  async clear(): Promise<void> {
    this.current = null;
  }

  async read(): Promise<StoredPushSubscription | null> {
    return this.current;
  }

  async replace(value: StoredPushSubscription): Promise<void> {
    this.current = value;
  }
}

async function run(): Promise<void> {
  const store = new MemoryPushSubscriptionStore();
  const sent: Array<{ payload: string; topic: string }> = [];
  const sender: PushSender = async (_subscription, payload, options) => {
    sent.push({ payload, topic: options.topic });
  };
  const service = new PushNotificationService({
    publicKey: vapidKeys.publicKey,
    privateKey: vapidKeys.privateKey,
    store,
    sender,
  });

  assert.deepEqual(await service.getStatus(), {
    configured: true,
    subscribed: false,
    subscribedAt: null,
  });

  await assert.rejects(
    service.replaceSubscription({
      endpoint: "not-a-push-endpoint",
      keys: { p256dh: "key", auth: "auth" },
    }),
    /valid browser push subscription/i,
  );

  await service.replaceSubscription(subscription);
  assert.equal((await service.getStatus()).subscribed, true);

  assert.equal(await service.sendTestNotification(), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].payload), {
    title: "Trading notifications enabled",
    body: "This phone is ready to receive trading alerts.",
    tag: "trading-test",
    url: "/",
  });

  assert.equal(
    await service.notifyOrderEvent({
      event: "fill",
      fillPrice: 23.45,
      quantity: 10,
      side: "buy",
      strategy: "bullFlagMomentum",
      symbol: "AAPL",
    }),
    true,
  );
  assert.equal(sent.length, 2);
  assert.equal(sent[1].topic, "order-AAPL");
  assert.match(sent[1].payload, /bullFlagMomentum/);

  const expiredSender: PushSender = async () => {
    throw { statusCode: 410 };
  };
  const expiringStore = new MemoryPushSubscriptionStore();
  expiringStore.current = subscription;
  const expiringService = new PushNotificationService({
    publicKey: vapidKeys.publicKey,
    privateKey: vapidKeys.privateKey,
    store: expiringStore,
    sender: expiredSender,
  });

  assert.equal(await expiringService.sendTestNotification(), false);
  assert.equal(expiringStore.current, null);

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "push-subscription-test-"),
  );
  try {
    const fileStore = new FilePushSubscriptionStore(
      path.join(temporaryDirectory, "push-subscription.json"),
    );
    await fileStore.replace(subscription);
    assert.deepEqual(await fileStore.read(), subscription);
    await fileStore.clear();
    assert.equal(await fileStore.read(), null);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }

  const unconfiguredService = new PushNotificationService({
    store: new MemoryPushSubscriptionStore(),
    sender,
  });
  assert.equal(await unconfiguredService.sendTestNotification(), false);

  console.log("Push notification service verification passed.");
}

void run();
