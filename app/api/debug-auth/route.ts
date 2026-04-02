import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SPOTIFY_COOKIE_NAMES } from "@/lib/spotify-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const cookieStore = await cookies();

  return NextResponse.json({
    hasAccessCookie: Boolean(cookieStore.get(SPOTIFY_COOKIE_NAMES.access)?.value),
    hasRefreshCookie: Boolean(cookieStore.get(SPOTIFY_COOKIE_NAMES.refresh)?.value),
    hasExpiryCookie: Boolean(cookieStore.get(SPOTIFY_COOKIE_NAMES.expiry)?.value),
    hasStateCookie: Boolean(cookieStore.get(SPOTIFY_COOKIE_NAMES.state)?.value),
    redirectUriConfigured: process.env.SPOTIFY_REDIRECT_URI || null,
    appUrlConfigured: process.env.NEXT_PUBLIC_APP_URL || null
  });
}
