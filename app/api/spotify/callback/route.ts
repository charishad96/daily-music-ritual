import { NextRequest, NextResponse } from "next/server";
import {
  clearSpotifySession,
  exchangeCodeForToken,
  getSpotifyAuthState,
  getSpotifyConfig,
  persistSpotifySession
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
    await persistSpotifySession(tokenResponse);
    return NextResponse.redirect(appUrl);
  } catch {
    await clearSpotifySession();
    return NextResponse.redirect(`${appUrl}?error=spotify_token`);
  }
}
