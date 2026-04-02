import { NextRequest, NextResponse } from "next/server";
import {
  clearSpotifySession,
  exchangeCodeForToken,
  getCookieOptions,
  getSpotifyAuthState,
  getSpotifyConfig,
  SPOTIFY_COOKIE_NAMES
} from "@/lib/spotify-auth";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const storedState = await getSpotifyAuthState();
  const { appUrl } = getSpotifyConfig();

  if (!code || !state || !storedState || state !== storedState) {
    await clearSpotifySession();
    return NextResponse.redirect(`${appUrl}?error=spotify_auth`);
  }

  try {
    const tokenResponse = await exchangeCodeForToken(code);
    const response = NextResponse.redirect(appUrl);
    const expiresAt = Date.now() + tokenResponse.expires_in * 1000;

    response.cookies.set(
      SPOTIFY_COOKIE_NAMES.access,
      tokenResponse.access_token,
      getCookieOptions(tokenResponse.expires_in)
    );

    if (tokenResponse.refresh_token) {
      response.cookies.set(
        SPOTIFY_COOKIE_NAMES.refresh,
        tokenResponse.refresh_token,
        getCookieOptions(60 * 60 * 24 * 30)
      );
    }

    response.cookies.set(
      SPOTIFY_COOKIE_NAMES.expiry,
      String(expiresAt),
      getCookieOptions(tokenResponse.expires_in)
    );

    response.cookies.set(SPOTIFY_COOKIE_NAMES.state, "", getCookieOptions(0));
    return response;
  } catch {
    await clearSpotifySession();
    return NextResponse.redirect(`${appUrl}?error=spotify_token`);
  }
}
