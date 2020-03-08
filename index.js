const yargs = require('yargs');
const CsvReader = require('./csv_reader');
const SpotifyClient = require('./spotify_client');

const args = yargs.option('path', {
  describe: 'Path to playlist folder from Takeout',
  demandOption: true,
}).argv;

// strip out trailing slash if it exists
const playlistFolder = args.path.replace(/\/$/, '');
console.log(`Using folder: ${playlistFolder}`);

(async () => {
  const spotifyClient = new SpotifyClient();
  const csvReader = new CsvReader(playlistFolder);

  await spotifyClient.loginToSpotify();
  const playlistName = await csvReader.getPlaylistName();
  const playlistId = await spotifyClient.createPlaylist(playlistName);
  const tracks = await csvReader.extractTracks();

  await spotifyClient.addTracksToPlaylist(tracks, playlistId, playlistName);
})();
