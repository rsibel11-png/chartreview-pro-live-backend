import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

const AWS_API_URL = Deno.env.get("AWS_API_URL") || "https://1h4kpspbs6.execute-api.us-east-1.amazonaws.com/prod";
const AWS_API_KEY = Deno.env.get("AWS_API_KEY") || "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

Deno.serve(async (req) => {
  // Handle preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { method = "GET", path, payload } = body;

    if (!path) {
      return Response.json({ error: "Missing path" }, { status: 400, headers: CORS_HEADERS });
    }

    const url = `${AWS_API_URL}${path}`;

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "x-api-key": AWS_API_KEY,
        "Content-Type": "application/json",
      },
    };

    if (method !== "GET" && method !== "DELETE" && payload) {
      fetchOptions.body = JSON.stringify(payload);
    }

    const res = await fetch(url, fetchOptions);
    const text = await res.text();
    console.log("[awsProxy] AWS status:", res.status, "body:", text.substring(0, 300));

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (res.status >= 200 && res.status < 300) {
      return Response.json(data, { status: 200, headers: CORS_HEADERS });
    } else {
      return Response.json({ error: data?.error || data?.message || text, aws_status: res.status }, { status: res.status, headers: CORS_HEADERS });
    }
  } catch (error) {
    console.error("[awsProxy] Error:", error.message);
    return Response.json({ error: error.message }, { status: 500, headers: CORS_HEADERS });
  }
});
