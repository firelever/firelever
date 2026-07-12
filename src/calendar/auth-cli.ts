// One-time Google Calendar consent: mints the long-lived refresh token that
// the server uses forever after (ADR-016). Run locally, not on the box:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run gcal-auth
// (or put both in .env first). Opens a consent URL, catches the redirect on
// localhost, prints GOOGLE_REFRESH_TOKEN to copy into .env / fly secrets.
import http from "http";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "../config.js";

const PORT = 8123;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/calendar";

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (create a Desktop-app OAuth client in Google Cloud Console).");
  process.exit(1);
}

const url =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // force a refresh token even on re-consent
  });

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url ?? "/", REDIRECT).searchParams.get("code");
  if (!code) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" }).end("<h3>Done — you can close this tab and return to the terminal.</h3>");
  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    }),
  }).then((r) => r.json() as Promise<{ refresh_token?: string; error?: string; error_description?: string }>);
  if (!tok.refresh_token) {
    console.error("No refresh token returned:", tok.error, tok.error_description ?? "");
    process.exit(1);
  }
  console.log("\nAdd this to .env and fly secrets:\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tok.refresh_token}\n`);
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log("Open this URL in your browser and approve calendar access:\n");
  console.log(url + "\n");
});
