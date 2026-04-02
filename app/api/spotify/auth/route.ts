import { NextResponse } from "next/server";
import { createSpotifyAuthorizeUrl, setSpotifyAuthState } from "@/lib/spotify-auth";

export async function GET() {
  const state = crypto.randomUUID();
  await setSpotifyAuthState(state);

  return NextResponse.redirect(createSpotifyAuthorizeUrl(state));
}
