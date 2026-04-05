import { NextResponse } from "next/server";
import { generateDailyRecommendations } from "@/lib/recommendations";
import { SpotifyApiError } from "@/lib/spotify";
import { getCurrentUserPlaylists, getCurrentUserProfile } from "@/lib/spotify";
import { getValidSpotifyAccessToken } from "@/lib/spotify-auth";
import type { ContextInput } from "@/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fallbackOnSpotifyReadError<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SpotifyApiError && (error.status === 401 || error.status === 403 || error.status === 429)) {
      return fallback;
    }

    throw error;
  }
}

const SPOTIFY_RESTRICTED_MESSAGE =
  "Spotify login worked, but this account does not have enough Web API access for this app yet. If the app is still in Spotify development mode, the app owner needs to add this Spotify user in Spotify Developer Dashboard > Users and Access.";

export async function GET() {
  try {
    const accessToken = await getValidSpotifyAccessToken();

    if (!accessToken) {
      return NextResponse.json({
        authenticated: false,
        debug: "missing_access_token"
      });
    }

    let restricted = false;
    let rateLimited = false;
    let profile = null;

    try {
      profile = await getCurrentUserProfile();
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 403) {
        restricted = true;
      } else if (error instanceof SpotifyApiError && error.status === 429) {
        rateLimited = true;
      } else if (error instanceof SpotifyApiError && error.status === 401) {
        return NextResponse.json({
          authenticated: false,
          debug: "spotify_profile_unauthorized"
        });
      } else {
        throw error;
      }
    }

    const playlists = restricted || rateLimited ? [] : await fallbackOnSpotifyReadError(() => getCurrentUserPlaylists(), []);

    return NextResponse.json({
      authenticated: true,
      restricted,
      rateLimited,
      restrictionReason: restricted ? SPOTIFY_RESTRICTED_MESSAGE : undefined,
      profile,
      playlists: playlists.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        description: playlist.description || "",
        images: playlist.images || [],
        tracksTotal: playlist.tracks?.total || 0
      }))
    });
  } catch (error) {
    return NextResponse.json({
      authenticated: false,
      debug: error instanceof Error ? error.message : "unknown_error"
    });
  }
}

export async function POST(request: Request) {
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    return NextResponse.json(
      {
        error: "Spotify authentication required."
      },
      {
        status: 401
      }
    );
  }

  try {
    try {
      await getCurrentUserProfile();
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 403) {
        return NextResponse.json(
          {
            error: SPOTIFY_RESTRICTED_MESSAGE
          },
          {
            status: 403
          }
        );
      }

      if (error instanceof SpotifyApiError && error.status === 429) {
        return NextResponse.json(
          {
            error: "Spotify is rate-limiting profile reads right now. Wait a moment, then try again."
          },
          {
            status: 429
          }
        );
      }

      throw error;
    }

    const context = (await request.json()) as ContextInput;
    const data = await generateDailyRecommendations(context);
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Recommendation generation failed."
      },
      {
        status: 500
      }
    );
  }
}
