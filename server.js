const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cron = require('node-cron');
const express = require('express');
const path = require('path');
const { si } = require('nyaapi');

const PORT = process.env.PORT || 7000;
const REALDEBRID_API_KEY = process.env.REALDEBRID_API_KEY || '';

let todayAnimeCache = [];

const manifest = {
  id: 'cz.anime.nyaa.rd',
  version: '1.0.0',
  name: 'Anime Today + Nyaa + RealDebrid',
  description: 'Dnešní anime epizody z AniList s torrenty z Nyaa.si',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  catalogs: [{
    type: 'series',
    id: 'anime-today',
    name: 'Dnešní Anime'
  }],
  idPrefixes: ['nyaa:'],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
};

const builder = new addonBuilder(manifest);

// ===== AniList API =====
async function getTodayAnime() {
  const query = `
    query ($weekStart: Int, $weekEnd: Int) {
      Page(page: 1, perPage: 50) {
        airingSchedules(airingAt_greater: $weekStart, airingAt_lesser: $weekEnd, sort: TIME) {
          id
          airingAt
          episode
          media {
            id
            title { romaji english native }
            coverImage { large }
            bannerImage
            description
            genres
            averageScore
            season
            seasonYear
          }
        }
      }
    }
  `;

  const now = Math.floor(Date.now() / 1000);
  const dayStart = now - (now % 86400);
  const dayEnd = dayStart + 86400;

  try {
    const response = await axios.post('https://graphql.anilist.co', {
      query,
      variables: { weekStart: dayStart, weekEnd: dayEnd }
    });
    return response.data?.data?.Page?.airingSchedules || [];
  } catch (error) {
    console.error('AniList error:', error.message);
    return [];
  }
}

// ===== Nyaa API =====
async function searchNyaa(animeName, episode) {
  const variants = [
    `${animeName} ${episode}`,
    `${animeName.split(':')[0].trim()} ${episode}`,
    `${animeName.replace(/Season \d+/i, '').replace(/Part \d+/i, '').trim()} ${episode}`
  ];

  for (const query of variants) {
    try {
      let torrents = [];
      for (let page = 1; page <= 2; page++) {
        const result = await si.searchPage(query, page, { filter: 0, category: '1_2' });
        if (result?.length) torrents = torrents.concat(result);
        else break;
      }
      if (torrents.length) {
        console.log(`Found ${torrents.length} torrents for "${query}"`);
        return torrents.sort((a, b) => b.seeders - a.seeders);
      }
    } catch (err) {
      console.error(`Nyaa error: ${err.message}`);
    }
  }
  return [];
}

// ===== RealDebrid API =====
async function getRealDebridStream(magnet, apiKey) {
  if (!apiKey) return null;
  
  try {
    // Add magnet
    const add = await axios.post(
      'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnet)}`,
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }}
    );
    
    const torrentId = add.data?.id;
    if (!torrentId) return null;

    // Select files
    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      'files=all',
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }}
    );

    // Wait and get links
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const info = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` }}
      );
      if (info.data?.links?.[0]) {
        // Unrestrict
        const unrestrict = await axios.post(
          'https://api.real-debrid.com/rest/1.0/unrestrict/link',
          `link=${encodeURIComponent(info.data.links[0])}`,
          { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }}
        );
        return unrestrict.data?.download || null;
      }
    }
    return null;
  } catch (err) {
    console.error('RealDebrid error:', err.message);
    return null;
  }
}

// ===== Cache =====
async function updateCache() {
  console.log('Updating cache...');
  todayAnimeCache = await getTodayAnime();
  console.log(`Cache: ${todayAnimeCache.length} anime`);
}

updateCache();
cron.schedule('*/15 * * * *', updateCache);

// ===== Stremio Handlers =====
builder.defineCatalogHandler(async (args) => {
  if (args.type !== 'series' || args.id !== 'anime-today') return { metas: [] };
  if (parseInt(args.extra?.skip) > 0) return { metas: [] };

  return {
    metas: todayAnimeCache.map(s => ({
      id: `nyaa:${s.media.id}:${s.episode}`,
      type: 'series',
      name: s.media.title.romaji || s.media.title.english || s.media.title.native,
      poster: s.media.coverImage.large,
      background: s.media.bannerImage,
      description: `Epizoda ${s.episode}\n\n${(s.media.description || '').replace(/<[^>]*>/g, '')}`,
      genres: s.media.genres || [],
      releaseInfo: `${s.media.season || ''} ${s.media.seasonYear || ''} - Ep ${s.episode}`.trim(),
      imdbRating: s.media.averageScore ? (s.media.averageScore / 10).toFixed(1) : undefined
    }))
  };
});

builder.defineMetaHandler(async (args) => {
  const [prefix, anilistId, episode] = args.id.split(':');
  if (prefix !== 'nyaa') return { meta: null };

  const schedule = todayAnimeCache.find(s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode));
  if (!schedule) return { meta: null };

  const m = schedule.media;
  return {
    meta: {
      id: args.id,
      type: 'series',
      name: m.title.romaji || m.title.english || m.title.native,
      poster: m.coverImage.large,
      background: m.bannerImage,
      description: (m.description || '').replace(/<[^>]*>/g, ''),
      genres: m.genres || [],
      releaseInfo: `${m.season || ''} ${m.seasonYear || ''} - Epizoda ${schedule.episode}`.trim(),
      imdbRating: m.averageScore ? (m.averageScore / 10).toFixed(1).toString() : undefined,
      videos: [{
        id: args.id,
        title: `Epizoda ${schedule.episode}`,
        episode: schedule.episode,
        season: 1,
        released: new Date(schedule.airingAt * 1000).toISOString()
      }]
    }
  };
});

builder.defineStreamHandler(async (args) => {
  const [prefix, anilistId, episode] = args.id.split(':');
  if (prefix !== 'nyaa') return { streams: [] };

  const schedule = todayAnimeCache.find(s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode));
  if (!schedule) return { streams: [] };

  const m = schedule.media;
  let torrents = await searchNyaa(m.title.romaji || m.title.english, parseInt(episode));
  
  if (!torrents.length && m.title.english !== m.title.romaji) {
    torrents = await searchNyaa(m.title.english || m.title.romaji, parseInt(episode));
  }

  if (!torrents.length) return { streams: [] };

  const rdKey = args.config?.rd || REALDEBRID_API_KEY;
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

  return {
    streams: torrents.filter(t => t.magnet).map(t => 
      rdKey ? {
        name: 'Nyaa + RealDebrid',
        title: `🎬 ${t.name}\n👥 ${t.seeders} | 📦 ${t.filesize}`,
        externalUrl: `${baseUrl}/rd/${encodeURIComponent(t.magnet)}?key=${encodeURIComponent(rdKey)}`
      } : {
        name: 'Nyaa (Magnet)',
        title: `${t.name}\n👥 ${t.seeders} | 📦 ${t.filesize}`,
        url: t.magnet,
        behaviorHints: { notWebReady: true }
      }
    )
  };
});

// ===== Express Server =====
const app = express();

// Redirect root to index.html (must be BEFORE static middleware)
app.get('/', (req, res, next) => {
  // Only redirect if accept header suggests browser (not Stremio API call)
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next(); // Let SDK handle API calls to /
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// RealDebrid callback
app.get('/rd/:magnet', async (req, res) => {
  const apiKey = req.query.key || REALDEBRID_API_KEY;
  if (!apiKey) return res.status(400).send('API key required');
  
  const stream = await getRealDebridStream(decodeURIComponent(req.params.magnet), apiKey);
  stream ? res.redirect(stream) : res.status(500).send('Failed');
});

// Start server
const addonInterface = builder.getInterface();

// Mount addon routes manually (without SDK landing page)
app.use(addonInterface);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📺 Addon: http://localhost:${PORT}/manifest.json`);
  console.log(`🌐 Setup: http://localhost:${PORT}/`);
});
