import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
const scope = process.env.GOOGLE_OAUTH_SCOPE || "https://www.googleapis.com/auth/calendar.events";
const requestedPort = Number.parseInt(process.env.GOOGLE_OAUTH_PORT || "8765", 10);

if (!clientId) {
  console.error("Missing GOOGLE_CLIENT_ID in the environment.");
  process.exit(1);
}

function base64UrlEncode(input) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomToken(size = 32) {
  return base64UrlEncode(crypto.randomBytes(size));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn(
        "powershell",
        ["-NoProfile", "-Command", "Start-Process", url],
        { detached: true, stdio: "ignore" }
      ).unref();
      return true;
    }

    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return true;
    }

    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

async function waitForAuthorizationCode(port, expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (returnedState !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("State mismatch. You can close this tab.");
          reject(new Error("OAuth state mismatch."));
          server.close();
          return;
        }

        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Google returned an error: ${error}. You can close this tab.`);
          reject(new Error(`Google OAuth error: ${error}`));
          server.close();
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Missing authorization code. You can close this tab.");
          reject(new Error("Missing authorization code in callback."));
          server.close();
          return;
        }

        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Google authorization complete. You can return to Maverick.");
        resolve(code);
        server.close();
      } catch (error) {
        reject(error);
        server.close();
      }
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

async function exchangeCodeForTokens({ code, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Token exchange failed with ${response.status}`);
  }

  return payload;
}

async function main() {
  const state = randomToken(24);
  const codeVerifier = randomToken(64);
  const codeChallenge = base64UrlEncode(sha256(codeVerifier));
  const redirectUri = `http://127.0.0.1:${requestedPort}`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log("Starting Google OAuth flow for Calendar access.");
  console.log(`Redirect URI: ${redirectUri}`);
  console.log("");
  console.log("If the browser does not open automatically, open this URL manually:");
  console.log(authUrl.toString());
  console.log("");

  openBrowser(authUrl.toString());

  const code = await waitForAuthorizationCode(requestedPort, state);
  const tokens = await exchangeCodeForTokens({
    code,
    redirectUri,
    codeVerifier,
  });

  console.log("");
  console.log("OAuth exchange complete.");
  console.log(`Access token present: ${Boolean(tokens.access_token)}`);
  console.log(`Refresh token: ${tokens.refresh_token || ""}`);

  if (!tokens.refresh_token) {
    console.log("");
    console.log("Google did not return a refresh token.");
    console.log("If this account already approved the app, revoke access and run the script again.");
  }
}

main().catch((error) => {
  console.error("");
  console.error("Google OAuth flow failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
