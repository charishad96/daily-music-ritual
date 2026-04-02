import { cookies } from "next/headers";

const ACCESS_COOKIE = "spotify_access_token";
const REFRESH_COOKIE = "spotify_refresh_token";
const EXPIRY_COOKIE = "spotify_token_expires_at";
const STATE_COOKIE = "spotify_auth_state";

const SPOTIFY_ACCOUNTS_URL = "https://accounts.spotify.com";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";

export const SPOTIFY_SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-top-read",
  "user-read-recently-played",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public"
];

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

export function getSpotifyConfig() {
  return {
    clientId: requireEnv("SPOTIFY_CLIENT_ID"),
    clientSecret: requireEnv("SPOTIFY_CLIENT_SECRET"),
    redirectUri: requireEnv("SPOTIFY_REDIRECT_URI"),
    appUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
  };
}

export function getCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge
  };
}

export function createSpotifyAuthorizeUrl(state: string) {
  const { clientId, redirectUri } = getSpotifyConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES.join(" "),
    state,
    show_dialog: "false"
  });

  return `${SPOTIFY_ACCOUNTS_URL}/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string) {
  const { clientId, clientSecret, redirectUri } = getSpotifyConfig();

  const response = await fetch(`${SPOTIFY_ACCOUNTS_URL}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    }).toString()
  });

  if (!response.ok) {
    throw new Error("Spotify token exchange failed.");
  }

  return response.json();
}

export async function refreshSpotifyToken(refreshToken: string) {
  const { clientId, clientSecret } = getSpotifyConfig();

  const response = await fetch(`${SPOTIFY_ACCOUNTS_URL}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    }).toString()
  });

  if (!response.ok) {
    throw new Error("Spotify token refresh failed.");
  }

  return response.json();
}

export async function persistSpotifySession(tokenResponse: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}) {
  const cookieStore = await cookies();
  const expiresAt = Date.now() + tokenResponse.expires_in * 1000;

  cookieStore.set(ACCESS_COOKIE, tokenResponse.access_token, getCookieOptions(tokenResponse.expires_in));

  if (tokenResponse.refresh_token) {
    cookieStore.set(REFRESH_COOKIE, tokenResponse.refresh_token, getCookieOptions(60 * 60 * 24 * 30));
  }

  cookieStore.set(EXPIRY_COOKIE, String(expiresAt), getCookieOptions(tokenResponse.expires_in));
}

export async function clearSpotifySession() {
  const cookieStore = await cookies();

  for (const cookieName of [ACCESS_COOKIE, REFRESH_COOKIE, EXPIRY_COOKIE, STATE_COOKIE]) {
    cookieStore.delete(cookieName);
  }
}

export async function setSpotifyAuthState(state: string) {
  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE, state, getCookieOptions(60 * 10));
}

export async function getSpotifyAuthState() {
  const cookieStore = await cookies();
  return cookieStore.get(STATE_COOKIE)?.value;
}

export async function getValidSpotifyAccessToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_COOKIE)?.value;
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;
  const expiresAt = Number(cookieStore.get(EXPIRY_COOKIE)?.value || 0);

  if (accessToken && expiresAt > Date.now() + 30_000) {
    return accessToken;
  }

  if (!refreshToken) {
    return accessToken ?? null;
  }

  const refreshed = await refreshSpotifyToken(refreshToken);
  await persistSpotifySession({
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? refreshToken,
    expires_in: refreshed.expires_in
  });

  return refreshed.access_token;
}

export { SPOTIFY_API_URL };
export const SPOTIFY_COOKIE_NAMES = {
  access: ACCESS_COOKIE,
  refresh: REFRESH_COOKIE,
  expiry: EXPIRY_COOKIE,
  state: STATE_COOKIE
};
