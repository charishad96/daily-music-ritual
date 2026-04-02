import { NextResponse } from "next/server";
import {
  createSpotifyAuthorizeUrl,
  getCookieOptions,
  SPOTIFY_COOKIE_NAMES
} from "@/lib/spotify-auth";

export async function GET() {
  const state = crypto.randomUUID();
  const response = NextResponse.redirect(createSpotifyAuthorizeUrl(state));
  response.cookies.set(SPOTIFY_COOKIE_NAMES.state, state, getCookieOptions(60 * 10));
  return response;
}
