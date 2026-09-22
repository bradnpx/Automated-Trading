import { NextRequest } from "next/server";

const ENGINE_API_URL = process.env.ENGINE_API_URL ?? "http://localhost:4001";
const NOTIFICATION_API_TOKEN = process.env.NOTIFICATION_API_TOKEN;
const ACTIONS = new Set(["status", "vapid-public-key", "subscription", "test"]);

type RouteContext = {
  params: Promise<{ action: string }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxyRequest(request, context);
}

async function proxyRequest(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const { action } = await context.params;
  if (!ACTIONS.has(action)) {
    return Response.json({ error: "Unknown notification action." }, { status: 404 });
  }

  if (!NOTIFICATION_API_TOKEN) {
    return Response.json(
      { error: "Notifications are not configured on the dashboard server." },
      { status: 503 },
    );
  }

  const targetUrl = new URL(`/notifications/${action}`, ENGINE_API_URL);
  const requestBody = ["PUT", "POST"].includes(request.method)
    ? await request.text()
    : undefined;

  try {
    const engineResponse = await fetch(targetUrl, {
      method: request.method,
      headers: {
        "Content-Type": request.headers.get("Content-Type") ?? "application/json",
        "X-Notification-Api-Token": NOTIFICATION_API_TOKEN,
      },
      body: requestBody,
      cache: "no-store",
    });

    const responseBody = await engineResponse.text();
    return new Response(engineResponse.status === 204 ? null : responseBody, {
      status: engineResponse.status,
      headers: {
        "Content-Type": engineResponse.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch {
    return Response.json(
      { error: "The dashboard could not reach the trading engine." },
      { status: 503 },
    );
  }
}
