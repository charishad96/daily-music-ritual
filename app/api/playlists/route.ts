import { NextResponse } from "next/server";
import { addItemsToPlaylist, createPlaylist } from "@/lib/spotify";
import { getValidSpotifyAccessToken } from "@/lib/spotify-auth";
import type { ContextInput } from "@/types";

type PlaylistRequest = {
  context: ContextInput;
  trackUris: string[];
};

export async function POST(request: Request) {
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    return NextResponse.json({ error: "Spotify authentication required." }, { status: 401 });
  }

  try {
    const body = (await request.json()) as PlaylistRequest;
    const dateLabel = new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric"
    }).format(new Date());
    const playlist = await createPlaylist(
      `Daily Ritual - ${body.context.mood} ${dateLabel}`,
      `Context: ${body.context.timeOfDay}, ${body.context.energyLevel} energy, familiarity ${body.context.familiarity}.`
    );

    await addItemsToPlaylist(playlist.id, body.trackUris);

    return NextResponse.json({
      playlistUrl: playlist.external_urls.spotify
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Playlist save failed."
      },
      {
        status: 500
      }
    );
  }
}
