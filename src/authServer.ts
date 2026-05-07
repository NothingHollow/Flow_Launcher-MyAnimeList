import { createServer, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAL_TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";

interface StoredAuth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  pendingAuth?: {
    codeVerifier: string;
    state: string;
    createdAt: number;
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const authFile = process.env.MAL_AUTH_FILE ?? path.join(process.cwd(), ".mal-auth.json");
const clientId = requireEnv("MAL_CLIENT_ID");
const clientSecret = process.env.MAL_CLIENT_SECRET?.trim();
const redirectUri = process.env.MAL_REDIRECT_URI ?? "http://127.0.0.1:53142/callback";
const host = process.env.MAL_AUTH_HOST ?? "127.0.0.1";
const port = Number(process.env.MAL_AUTH_PORT ?? "53142");
const timeoutMs = Number(process.env.MAL_AUTH_TIMEOUT_MS ?? String(5 * 60 * 1000));

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", redirectUri);

  if (requestUrl.pathname === "/health") {
    return sendText(res, 200, "ok");
  }

  if (requestUrl.pathname !== "/callback") {
    return sendHtml(res, 404, "MyAnimeList auth", "Unknown callback path.");
  }

  try {
    const providerError = requestUrl.searchParams.get("error");
    if (providerError) {
      throw new Error(requestUrl.searchParams.get("error_description") ?? providerError);
    }

    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    if (!code) {
      throw new Error("MyAnimeList did not provide an authorization code.");
    }

    const storedAuth = readStoredAuth();
    const pendingAuth = storedAuth.pendingAuth;
    if (!pendingAuth) {
      throw new Error("No pending MyAnimeList sign-in was found. Start again from Flow Launcher.");
    }

    if (!state || state !== pendingAuth.state) {
      throw new Error("The OAuth state from MyAnimeList did not match this sign-in.");
    }

    const token = await requestToken(code, pendingAuth.codeVerifier);
    saveToken(token, storedAuth);
    sendHtml(
      res,
      200,
      "MyAnimeList connected",
      "Your MyAnimeList account is connected. You can close this tab and use Flow Launcher.",
    );
  } catch (error) {
    sendHtml(res, 400, "MyAnimeList auth failed", error instanceof Error ? error.message : String(error));
  } finally {
    closeSoon();
  }
});

const timeout = setTimeout(() => {
  closeSoon();
}, timeoutMs);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    process.exit(0);
  }

  process.exit(1);
});

server.listen(port, host);

async function requestToken(code: string, codeVerifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetch(MAL_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as TokenResponse;
}

function saveToken(token: TokenResponse, storedAuth: StoredAuth): void {
  writeStoredAuth({
    ...storedAuth,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? storedAuth.refreshToken,
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    pendingAuth: undefined,
  });
}

function readStoredAuth(): StoredAuth {
  if (!existsSync(authFile)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(authFile, "utf8")) as StoredAuth;
  } catch {
    return {};
  }
}

function writeStoredAuth(auth: StoredAuth): void {
  writeFileSync(authFile, JSON.stringify(auth, null, 2), "utf8");
}

async function readApiError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const message = data.message ?? data.error_description ?? data.error;
    if (message) {
      return `${response.status} ${response.statusText}: ${String(message)}`;
    }
  } catch {
    // Fall through to the raw response text.
  }

  return `${response.status} ${response.statusText}${text ? `: ${text}` : ""}`;
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, title: string, message: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        background: #111827;
        color: #f9fafb;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }
      main {
        max-width: 520px;
        padding: 32px;
      }
      h1 {
        font-size: 28px;
        margin: 0 0 12px;
      }
      p {
        color: #d1d5db;
        font-size: 16px;
        line-height: 1.5;
        margin: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function closeSoon(): void {
  clearTimeout(timeout);
  setTimeout(() => {
    server.close(() => process.exit(0));
  }, 250);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}
