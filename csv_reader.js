const csv = require('csvtojson');
const globby = require('globby');
const Entities = require('html-entities').AllHtmlEntities;

class CsvReader {
  constructor(playlistFolder) {
    this.playlistFolder = playlistFolder;
    this.htmlParser = new Entities();
  }

  /** @param {string} path the path to the csv file. */
  async readCsv(path) {
    return await csv().fromFile(path);
  }

  async getPlaylistName() {
    return await this.readCsv(this.playlistFolder + '/Metadata.csv').then(
      (metadata) => {
        return metadata[0]['Title'];
      },
    );
  }

  async extractTracks() {
    const trackPaths = (await globby(
      this.playlistFolder + '/Tracks/*.csv',
    )).filter((path) => {
      const filename = path.split('/').pop();
      return !/^\(\d+\)\.csv$/.test(filename);
    });
    // console.log('Track Paths');
    // console.log(trackPaths);
    const tracks = [];
    for (let path of trackPaths) {
      const trackObj = this.getTrackObjectFromCsv(await this.readCsv(path));
      // console.log(trackObj);
      tracks.push(trackObj);
    }
    return tracks.sort(
      (track1, track2) => track1.playlistIndex - track2.playlistIndex,
    );
  }

  getTrackObjectFromCsv(csvData) {
    // ASSUMPTION: One track per csv file.
    const trackFromCsv = csvData[0];
    return {
      title: this.htmlParser.decode(trackFromCsv['Title'] || ''),
      artist: this.htmlParser.decode(trackFromCsv['Artist'] || ''),
      album: this.htmlParser.decode(trackFromCsv['Album'] || ''),
      durationMs: Number(trackFromCsv['Duration (ms)'] || ''),
      playlistIndex: Number(trackFromCsv['Playlist Index'] || ''),
    };
  }
}

module.exports = CsvReader;
