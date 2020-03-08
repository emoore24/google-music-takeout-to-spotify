const SpotifyWebApi = require('spotify-web-api-node');
const open = require('open');
const readlineSync = require('readline-sync');
const fs = require('fs');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const CLIENT_ID = 'ce753e7e0dd944c18722972b261a864c';
const CLIENT_SECRET = '8bf7ec21468e4ee8bd0ddb380a097ef7';
const REDIRECT_URI = 'http://localhost';

class SpotifyClient {
  constructor() {
    this.spotifyApi = new SpotifyWebApi({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });
    // Create an array of failed tracks to log later.
    this.failedTracks = [];
  }

  async loginToSpotify() {
    let tokenData;
    let shouldRefresh = false;
    try {
      const jsonString = fs.readFileSync('./_token.json', {
        encoding: 'utf-8',
      });
      tokenData = JSON.parse(jsonString);
      console.log(`TOKEN from Cache:\n`, tokenData);
      if (
        !tokenData['expires_in'] ||
        !tokenData['access_token'] ||
        !tokenData['refresh_token']
      ) {
        throw 'Token Data missing';
      }
      this.spotifyApi.setAccessToken(tokenData['access_token']);
      this.spotifyApi.setRefreshToken(tokenData['refresh_token']);

      let userDetails;
      // get user details
      userDetails = await this.spotifyApi
        .getMe()
        .then((data) => data.body)
        .catch(async (err) => {
          // if call fails, refresh token and try again.  If this fails we'll
          // prompt below
          console.log(err);
          console.log('refreshing token');
          tokenData = (await this.spotifyApi.refreshAccessToken()).body;
          this.spotifyApi.setAccessToken(tokenData['access_token']);
          this.writeTokenToCache(tokenData);
          return (await this.spotifyApi.getMe()).body;
        });
      this.userId = userDetails.id;
    } catch (e) {
      console.log('No Token in cache, prompting for auth');
      const data = await this.promptForAuthorization();
      tokenData = data.body;
      this.writeTokenToCache(tokenData);

      this.spotifyApi.setAccessToken(tokenData['access_token']);
      this.spotifyApi.setRefreshToken(tokenData['refresh_token']);

      const userDetails = (await this.spotifyApi.getMe()).body;
      this.userId = userDetails.id;
    }
  }

  async promptForAuthorization() {
    const scopes = ['playlist-read-private', 'playlist-modify-private'];
    const authorizeUrl = this.spotifyApi.createAuthorizeURL(scopes);

    console.log(`Opening Authorize URL: ${authorizeUrl}`);
    await open(authorizeUrl);

    const code = readlineSync.question('Input authorization code: ');

    return await this.spotifyApi.authorizationCodeGrant(code);
  }

  writeTokenToCache(tokenData) {
    const jsonString = JSON.stringify(tokenData);
    fs.writeFileSync('./_token.json', jsonString);
  }

  async createPlaylist(playlistName) {
    const existingPlaylist = await this.getExistingPlaylist(playlistName);

    if (existingPlaylist) {
      console.log(`Playlist ${playlistName} exists, adding to existing`);
      return existingPlaylist.id;
    } else {
      console.log(`Creating playlist: ${playlistName}`);
      const playlistInfo = await this.spotifyApi.createPlaylist(
        this.userId,
        playlistName,
        {
          public: false,
        },
      );
      return playlistInfo.body.id;
    }
  }

  async getExistingPlaylist(playlistName) {
    let next = null;
    let offset = 0;
    do {
      const response = (await this.spotifyApi.getUserPlaylists(this.userId, {
        limit: 50,
        offset,
      })).body;

      const existingPlaylists = response.items.filter(
        (playlist) => playlist.name === playlistName,
      );

      if (existingPlaylists.length > 0) {
        return existingPlaylists[0];
      }

      next = response.next;
      offset += 50;
    } while (next);

    return null;
  }

  async addTracksToPlaylist(tracks, playlistId, playlistName) {
    const songsToAdd = [];
    for (let track of tracks) {
      const spotifySong = await this.searchTrackInSpotify(track);
      if (spotifySong) {
        songsToAdd.push(spotifySong);
      } else {
        this.failedTracks.push(track);
      }
    }
    await this.addToPlaylist(songsToAdd, playlistId);
    await this.writeFailedTracks(playlistName);
  }

  async searchTrackInSpotify(track) {
    try {
      let matchingTracks = await this.getMatchingTracksFromSearch(track);

      if (matchingTracks.length === 0) {
        let parenIndex = track.title.indexOf('(');
        if (parenIndex < 0) {
          parenIndex = undefined;
        }
        let newSearch = track.title.substring(0, parenIndex).trim();
        newSearch += ` ${track.artist}`;
        console.log(`Found no matching tracks, trying again with ${newSearch}`);
        matchingTracks = await this.getMatchingTracksFromSearch(
          track,
          newSearch,
        );
      }

      if (matchingTracks.length > 1) {
        // Prefer explicit version
        console.log(
          `Multiple matches (${matchingTracks.length}) found for ${track.title}, searching for explicit one`,
        );
        const explicitVersion = matchingTracks.find(
          (track) => track.isExplicit,
        );
        return explicitVersion || matchingTracks[0];
      }
      return matchingTracks[0];
    } catch (e) {
      console.log(`Failed to search for track ${track.title}:`);
      console.log(e);
    }
  }

  async getMatchingTracksFromSearch(track, optSearchTerm) {
    const searchResponse = (await this.spotifyApi.searchTracks(
      optSearchTerm || track.title,
      {
        limit: 20,
      },
    )).body;
    const searchResults = searchResponse.tracks.items.map((item) => {
      return {
        title: item.name,
        album: item.album.name,
        artists: item.artists.map((artist) => artist.name),
        isExplicit: item.explicit,
        durationMs: item['duration_ms'],
        uri: item.uri,
        // Save reference to the track from the Csv
        csvTrack: track,
      };
    });

    console.log(
      `Looking for ${optSearchTerm || track.title}, ${track.artist}, ` +
        `${track.album}, ${track.durationMs}`,
    );
    return searchResults.filter((result) => {
      const titleMatch = result.title === track.title;
      const albumMatch = result.album === track.album;
      const durationMsMatch = result.durationMs === track.durationMs;
      const artistMatch = result.artists.indexOf(track.artist) > -1;
      return albumMatch || durationMsMatch || artistMatch;
    });
  }

  async addToPlaylist(songs, playlistId) {
    // Dedupe any songs that were in the playlist already.
    const songsToAdd = Array.from(
      new Set(songs.map((s) => JSON.stringify(s))),
    ).map((item) => JSON.parse(item));
    console.log(
      `Adding ${songsToAdd.length} songs: ${songsToAdd.map((s) => s.title)}`,
    );
    while (songsToAdd.length > 0) {
      // Add in batches of 15
      const songBatch = songsToAdd.splice(0, 15);
      const uriBatch = songBatch.map((s) => s.uri);
      console.log('adding batch of 15 songs');
      try {
        await this.spotifyApi.addTracksToPlaylist(playlistId, uriBatch);
      } catch (e) {
        console.log('Failed to add songs');
        console.log(e);
        for (let song of songs) {
          this.failedTracks.push(song.csvTrack);
        }
      }
    }
  }

  async writeFailedTracks(playlistName) {
    const csvWriter = createCsvWriter({
      path: `${playlistName.replace(/[ \/]/g, '_')}_failedTracks.csv`,
      header: [
        { id: 'title', title: 'Title' },
        { id: 'artist', title: 'Artist' },
        { id: 'album', title: 'Album' },
        { id: 'durationMs', title: 'Duration (ms)' },
      ],
    });
    await csvWriter.writeRecords(this.failedTracks);
  }
}

module.exports = SpotifyClient;
