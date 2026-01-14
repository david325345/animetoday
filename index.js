// Upravené index.js pro Render.com (používá RENDER_EXTERNAL_URL pokud je dostupné)
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { addonBuilder } = require('stremio-addon-sdk');

const PORT = process.env.PORT || 7000;
// Render poskytuje RENDER_EXTERNAL_URL s veřejnou URL (např. https://your-service.onrender.com)
const HOST = process.env.HOST || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const MANIFEST_URL = `${HOST}/manifest.json`;

const manifest = {
  id: 'org.david325345.todaysanime',
  version: '0.0.1',
  name: 'Dnešní anime (AniList + Nyaa)',
  description: 'Dnešní vysílání anime z AniList + vyhledání torrentů na nyaa.si (magnet links)',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['anilist:'],
  catalogs: [
    {
      type: 'movie',
      id: 'today',
      name: 'Dnešní anime (AniList)'
    }
  ],
  contactEmail: 'noreply@example.com',
  logo: 'https://raw.githubusercontent.com/Stremio/stremio-addon-sdk/master/examples/assets/stremio.png'
};

const builder = new addonBuilder(manifest);

// Helper: AniList — vyhledat airing schedule pro dnešek (UTC)
async function fetchTodaysAiring() {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0) / 1000;
  const end = start + 24 * 3600 - 1;

  const query = `
    query ($start: Int, $end: Int) {
      Page(perPage: 50) {
        airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: [TIME, EPISODE]) {
          airingAt
          episode
          media {
            id
            title { romaji english native }
            coverImage { large medium }
            format
            status
            episodes
          }
        }
      }
    }
  `;
  const variables = { start: Math.floor(start), end: Math.floor(end) };

  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    throw new Error('AniList request failed: ' + res.statusText);
  }

  const data = await res.json();
  const schedules = (data.data && data.data.Page && data.data.Page.airingSchedules) || [];
  return schedules;
}

// Catalog handler
builder.defineCatalogHandler(async (args, cb) => {
  try {
    if (args.id !== 'today') return cb(null, { metas: [] });

    const schedules = await fetchTodaysAiring();
    const metas = schedules.map(s => {
      const media = s.media;
      const title = media.title.english || media.title.romaji || media.title.native || 'Unknown';
      const episode = s.episode;
      const id = `anilist:${media.id}:ep:${episode}`;
      const name = `${title} — Ep ${episode}`;
      const poster = media.coverImage && media.coverImage.large;
      return {
        id,
        name,
        type: 'movie',
        poster,
        posterShape: 'poster'
      };
    });

    return cb(null, { metas });
  } catch (err) {
    console.error('Catalog error', err);
    return cb(null, { metas: [] });
  }
});

// Meta handler
builder.defineMetaHandler(async (args, cb) => {
  try {
    const id = args.id;
    const m = id.match(/^anilist:(\d+):ep:(\d+)$/);
    if (!m) return cb(null, { meta: null });

    const mediaId = m[1];
    const episode = m[2];

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          title { romaji english native }
          description (asHtml: false)
          coverImage { large medium }
          episodes
          season
          seasonYear
        }
      }
    `;
    const variables = { id: parseInt(mediaId, 10) };
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    const data = await res.json();
    const media = data.data && data.data.Media;
    if (!media) return cb(null, { meta: null });

    const title = media.title.english || media.title.romaji || media.title.native || 'Unknown';
    const meta = {
      id: args.id,
      type: 'movie',
      name: `${title} — Ep ${episode}`,
      poster: media.coverImage && media.coverImage.large,
      description: media.description ? (media.description.replace(/<[^>]+>/g, '') + `\n\nSource: AniList`) : `Episode ${episode}`,
      releaseInfo: media.seasonYear ? `${media.season || ''} ${media.seasonYear}` : '',
      imdbRating: 0,
      videos: []
    };

    return cb(null, { meta });
  } catch (err) {
    console.error('Meta error', err);
    return cb(null, { meta: null });
  }
});

// Stream handler — vyhledá na nyaa.si magnet links
builder.defineStreamHandler(async (args, cb) => {
  try {
    const id = args.id;
    const m = id.match(/^anilist:(\d+):ep:(\d+)$/);
    if (!m) return cb(null, { streams: [] });

    const mediaId = m[1];
    const episode = m[2];

    const queryMedia = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          title { romaji english native }
        }
      }
    `;
    const variables = { id: parseInt(mediaId, 10) };
    const resMedia = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: queryMedia, variables })
    });
    const jsonMedia = await resMedia.json();
    const title = (jsonMedia.data && jsonMedia.data.Media && (jsonMedia.data.Media.title.english || jsonMedia.data.Media.title.romaji || jsonMedia.data.Media.title.native)) || `anime ${mediaId}`;

    const searchQuery = `${title} ${episode}`;
    const nyaaUrl = `https://nyaa.si/?f=0&c=1_0&q=${encodeURIComponent(searchQuery)}&s=seeders&o=desc`;

    const res = await fetch(nyaaUrl, { headers: { 'User-Agent': 'stremio-addon' } });
    if (!res.ok) {
      console.warn('Nyaa search failed', res.status);
      return cb(null, { streams: [] });
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    const streams = [];
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      if (href.startsWith('magnet:')) {
        const parent = $(el).closest('tr');
        const titleCell = parent.find('.torrent-name').text() || parent.find('td:nth-child(2)').text() || '';
        const mBtih = href.match(/xt=urn:btih:([0-9A-Fa-f]{40,})/);
        const infoHash = mBtih ? mBtih[1].toLowerCase() : undefined;
        streams.push({
          title: titleCell.trim() || `${title} Ep ${episode} (nyaa)`,
          magnet: href,
          infoHash,
          isFree: true
        });
      }
    });

    return cb(null, { streams });
  } catch (err) {
    console.error('Stream error', err);
    return cb(null, { streams: [] });
  }
});

// Expose manifest and web installer
const app = express();
app.get('/manifest.json', (req, res) => {
  res.json(builder.getManifest());
});

app.get('/install', (req, res) => {
  const html = `
  <html>
    <head><meta charset="utf-8"><title>Install Dnešní anime (AniList + Nyaa)</title></head>
    <body style="font-family: Arial, sans-serif; padding:20px;">
      <h1>Install Dnešní anime (AniList + Nyaa)</h1>
      <p>Pokud máš Stremio desktop klient, klikni na odkaz níže (pokud klient podporuje stremio-protocol):</p>
      <p><a href="stremio://manifest?url=${encodeURIComponent(MANIFEST_URL)}">Instalovat add-on do Stremio</a></p>
      <p>Pokud protokol nefunguje, otevři Stremio → Add-ons → My add-ons → Manual install a vlož tuto URL:</p>
      <pre>${MANIFEST_URL}</pre>
      <p>Manifest je také dostupný přímo: <a href="${MANIFEST_URL}" target="_blank">${MANIFEST_URL}</a></p>
    </body>
  </html>
  `;
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

app.use('/', builder.getRouter());

app.listen(PORT, () => {
  console.log(`Addon running at ${HOST} (port ${PORT})`);
  console.log(`Manifest: ${MANIFEST_URL}`);
  console.log(`Web installer: ${HOST}/install`);
});