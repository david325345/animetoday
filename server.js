const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cron = require('node-cron');
const express = require('express');
const path = require('path');
const { si } = require('nyaapi');
const crypto = require('crypto');

const PORT = process.env.PORT || 7000;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

let todayAnimeCache = [];

const manifest = {
  id: 'cz.anime.nyaa.rd',
  version: '1.3.0',
  name: 'Anime Today + Nyaa',
  description: 'Dnešní anime s Nyaa torrenty přes RealDebrid',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  catalogs: [{
    type: 'series',
    id: 'anime-today',
    name: 'Dnešní Anime',
    extra: [{ name: 'skip', isRequired: false }]
  }],
  idPrefixes: ['nyaa:'],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
};

// Funkce pro dekódování config z URL
function decodeConfig(req) {
  const urlPath = req.path || req.url;
  const match = urlPath.match(/^\/([A-Za-z0-9+/=]+)\//);
  if (match) {
    try {
      return JSON.parse(Buffer.from(match[1], 'base64').toString());
    } catch (e) {}
  }
  return {};
}

const builder = new addonBuilder(manifest);

// ===== TMDB API =====
async function searchTMDB(animeName, year) {
  if (!TMDB_API_KEY) return null;
  try {
    const response = await axios.get('https://api.themoviedb.org/3/search/tv', {
      params: { api_key: TMDB_API_KEY, query: animeName, first_air_date_year: year },
      timeout: 5000
    });
    return response.data?.results?.[0]?.id || null;
  } catch (err) {
    return null;
  }
}

async function getTMDBImages(tmdbId) {
  if (!TMDB_API_KEY || !tmdbId) return null;
  try {
    const response = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/images`, {
      params: { api_key: TMDB_API_KEY },
      timeout: 5000
    });
    const backdrops = response.data?.backdrops || [];
    const posters = response.data?.posters || [];
    const backdrop = backdrops.find(b => b.iso_639_1 === 'en' || !b.iso_639_1) || backdrops[0];
    const poster = posters.find(p => p.iso_639_1 === 'en' || !p.iso_639_1) || posters[0];
    return {
      backdrop: backdrop ? `https://image.tmdb.org/t/p/w1280${backdrop.file_path}` : null,
      poster: poster ? `https://image.tmdb.org/t/p/w500${poster.file_path}` : null
    };
  } catch (err) {
    return null;
  }
}

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
            coverImage { extraLarge large }
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
  const cleanName = (name) => name
    .replace(/Season \d+/i, '').replace(/Part \d+/i, '')
    .replace(/2nd Season/i, '').replace(/3rd Season/i, '')
    .replace(/\([^)]*\)/g, '').replace(/:/g, '').trim();
  
  const variants = [
    `${animeName} ${episode}`,
    `${cleanName(animeName)} ${episode}`,
    `${animeName.split(':')[0].trim()} ${episode}`,
    `${animeName.split('-')[0].trim()} ${episode}`,
  ];
  
  const noSpecialChars = animeName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (noSpecialChars !== animeName) {
    variants.push(`${noSpecialChars} ${episode}`);
  }

  let allTorrents = [];
  const seenHashes = new Set();

  for (const query of variants) {
    try {
      let torrents = [];
      for (let page = 1; page <= 2; page++) {
        const result = await si.searchPage(query, page, { filter: 0, category: '1_2' });
        if (result?.length) torrents = torrents.concat(result);
        else break;
      }
      
      for (const t of torrents) {
        const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/)?.[1];
        if (hash && !seenHashes.has(hash)) {
          seenHashes.add(hash);
          allTorrents.push(t);
        }
      }
      
      if (torrents.length) {
        console.log(`Found ${torrents.length} torrents for "${query}"`);
      }
    } catch (err) {
      console.error(`Nyaa error: ${err.message}`);
    }
  }
  
  if (allTorrents.length) {
    console.log(`Total unique: ${allTorrents.length} torrents`);
    return allTorrents.sort((a, b) => b.seeders - a.seeders);
  }
  return [];
}

// ===== RealDebrid API =====
async function getRealDebridStream(magnet, apiKey) {
  if (!apiKey) return null;
  try {
    const add = await axios.post(
      'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnet)}`,
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    const torrentId = add.data?.id;
    if (!torrentId) return null;
    
    const torrentInfo = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers: { 'Authorization': `Bearer ${apiKey}` }}
    );
    const files = torrentInfo.data?.files;
    if (!files || files.length === 0) return null;
    const fileIds = files.map((f, i) => i + 1).join(',');
    
    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      `files=${fileIds}`,
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }}
    );

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const info = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` }}
      );
      if (info.data?.links?.[0]) {
        const unrestrict = await axios.post(
          'https://api.real-debrid.com/rest/1.0/unrestrict/link',
          `link=${encodeURIComponent(info.data.links[0])}`,
          { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }}
        );
        if (unrestrict.data?.download) {
          console.log('RD: ✅ Success!');
          return unrestrict.data.download;
        }
      }
    }
    return null;
  } catch (err) {
    console.error('RealDebrid error:', err.response?.status, err.response?.data || err.message);
    return null;
  }
}

// ===== Cache Update =====
async function updateCache() {
  console.log('🔄 Updating cache...');
  const schedules = await getTodayAnime();
  for (const schedule of schedules) {
    const media = schedule.media;
    const englishTitle = media.title.english || media.title.romaji;
    const year = media.seasonYear;
    const tmdbId = await searchTMDB(englishTitle, year);
    if (tmdbId) {
      const images = await getTMDBImages(tmdbId);
      if (images) {
        schedule.tmdbImages = images;
        console.log(`✅ TMDB: ${englishTitle}`);
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  todayAnimeCache = schedules;
  console.log(`✅ Cache: ${todayAnimeCache.length} anime`);
}

cron.schedule('0 4 * * *', updateCache);
updateCache();

// ===== Stremio Handlers =====
builder.defineCatalogHandler(async (args) => {
  if (args.type !== 'series' || args.id !== 'anime-today') return { metas: [] };
  if (parseInt(args.extra?.skip) > 0) return { metas: [] };

  // Pro každý request můžeme použít user TMDB klíč pokud existuje
  const userTmdbKey = args.config?.tmdb || TMDB_API_KEY;

  return {
    metas: todayAnimeCache.map(s => {
      let poster = s.tmdbImages?.poster || s.media.coverImage.extraLarge || s.media.coverImage.large;
      if (!poster || poster === 'null' || poster === '') {
        poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
      }
      const background = s.media.bannerImage || s.tmdbImages?.backdrop || poster;
      return {
        id: `nyaa:${s.media.id}:${s.episode}`,
        type: 'series',
        name: s.media.title.romaji || s.media.title.english || s.media.title.native,
        poster: poster,
        background: background || poster,
        logo: s.media.bannerImage || undefined,
        description: `Epizoda ${s.episode}\n\n${(s.media.description || '').replace(/<[^>]*>/g, '')}`,
        genres: s.media.genres || [],
        releaseInfo: `${s.media.season || ''} ${s.media.seasonYear || ''} - Ep ${s.episode}`.trim(),
        imdbRating: s.media.averageScore ? (s.media.averageScore / 10).toFixed(1) : undefined
      };
    })
  };
});

builder.defineMetaHandler(async (args) => {
  const [prefix, anilistId, episode] = args.id.split(':');
  if (prefix !== 'nyaa') return { meta: null };
  const schedule = todayAnimeCache.find(s => s.media.id === parseInt(anilistId) && s.episode === parseInt(episode));
  if (!schedule) return { meta: null};
  
  const m = schedule.media;
  let poster = schedule.tmdbImages?.poster || m.coverImage.extraLarge || m.coverImage.large;
  if (!poster || poster === 'null' || poster === '') {
    poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
  }
  const background = m.bannerImage || schedule.tmdbImages?.backdrop || poster;
  
  return {
    meta: {
      id: args.id,
      type: 'series',
      name: m.title.romaji || m.title.english || m.title.native,
      poster: poster,
      background: background || poster,
      logo: m.bannerImage || undefined,
      description: (m.description || '').replace(/<[^>]*>/g, ''),
      genres: m.genres || [],
      releaseInfo: `${m.season || ''} ${m.seasonYear || ''} - Epizoda ${schedule.episode}`.trim(),
      imdbRating: m.averageScore ? (m.averageScore / 10).toFixed(1).toString() : undefined,
      videos: [{
        id: args.id,
        title: `Epizoda ${schedule.episode}`,
        episode: schedule.episode,
        season: 1,
        released: new Date(schedule.airingAt * 1000).toISOString(),
        thumbnail: poster
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

  // Získat RD klíč z config
  const rdKey = args.config?.rd;
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  
  console.log('Stream - RD key:', rdKey ? 'yes' : 'no');

  return {
    streams: torrents.filter(t => t.magnet).map(t => {
      if (rdKey) {
        const streamUrl = `${baseUrl}/rd/${encodeURIComponent(t.magnet)}?key=${encodeURIComponent(rdKey)}`;
        return {
          name: 'Nyaa + RealDebrid',
          title: `🎬 ${t.name}\n👥 ${t.seeders} | 📦 ${t.filesize}`,
          url: streamUrl,
          behaviorHints: { bingeGroup: 'nyaa-rd' }
        };
      } else {
        return {
          name: 'Nyaa (Magnet)',
          title: `${t.name}\n👥 ${t.seeders} | 📦 ${t.filesize}`,
          url: t.magnet,
          behaviorHints: { notWebReady: true }
        };
      }
    })
  };
});

// ===== Express Server =====
const app = express();

// Middleware pro dekódování config z URL
app.use((req, res, next) => {
  const config = decodeConfig(req);
  if (config.rd) {
    req.userConfig = config;
  }
  next();
});

// ROOT route - naše landing page (PŘED static middleware)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/rd/:magnet', async (req, res) => {
  const apiKey = req.query.key;
  if (!apiKey) return res.status(400).send('API key required');
  const stream = await getRealDebridStream(decodeURIComponent(req.params.magnet), apiKey);
  stream ? res.redirect(stream) : res.status(500).send('Failed');
});

// Získat addon interface
const addonInterface = builder.getInterface();

// Custom manifest handler pro config v query parametru
app.get('/manifest.json', (req, res) => {
  if (req.query.c) {
    try {
      const config = JSON.parse(Buffer.from(decodeURIComponent(req.query.c), 'base64').toString());
      const customManifest = { ...manifest };
      const hash = require('crypto').createHash('md5').update(JSON.stringify(config)).digest('hex').substring(0, 8);
      customManifest.id = `${manifest.id}.${hash}`;
      customManifest.name = 'Anime Today (Personal)';
      console.log('Custom manifest with config:', config.rd ? 'RD+' : '', config.tmdb ? 'TMDB' : '');
      res.json(customManifest);
      return;
    } catch (err) {
      console.error('Config decode error:', err.message);
    }
  }
  // Default manifest
  res.json(manifest);
});

// Addon routes s config
app.get('/catalog/:type/:id.json', async (req, res) => {
  try {
    const config = req.query.c ? JSON.parse(Buffer.from(decodeURIComponent(req.query.c), 'base64').toString()) : {};
    const result = await addonInterface.catalog({ type: req.params.type, id: req.params.id, extra: req.query, config });
    res.json(result);
  } catch (err) {
    res.status(500).json({ metas: [] });
  }
});

app.get('/meta/:type/:id.json', async (req, res) => {
  try {
    const config = req.query.c ? JSON.parse(Buffer.from(decodeURIComponent(req.query.c), 'base64').toString()) : {};
    const result = await addonInterface.meta({ type: req.params.type, id: req.params.id, config });
    res.json(result);
  } catch (err) {
    res.status(500).json({ meta: null });
  }
});

app.get('/stream/:type/:id.json', async (req, res) => {
  try {
    const config = req.query.c ? JSON.parse(Buffer.from(decodeURIComponent(req.query.c), 'base64').toString()) : {};
    const result = await addonInterface.stream({ type: req.params.type, id: req.params.id, config });
    res.json(result);
  } catch (err) {
    res.status(500).json({ streams: [] });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server: http://localhost:${PORT}/`);
});
