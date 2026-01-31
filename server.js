const { addonBuilder, getRouter } = require('stremio-addon-sdk');
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
  version: '1.0.1',
  name: 'Anime Today + Nyaa + RealDebrid',
  description: 'Dnešní anime epizody z AniList s torrenty z Nyaa.si',
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
    configurable: false,
    configurationRequired: false
  }
};

// Cache pro RD klíče podle user agenta (workaround)
const rdKeyCache = new Map();

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
    console.log('RD: Adding magnet...');
    
    // Add magnet
    const add = await axios.post(
      'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnet)}`,
      { 
        headers: { 
          'Authorization': `Bearer ${apiKey}`, 
          'Content-Type': 'application/x-www-form-urlencoded' 
        },
        timeout: 10000
      }
    );
    
    const torrentId = add.data?.id;
    if (!torrentId) {
      console.log('RD: No torrent ID');
      return null;
    }
    
    console.log(`RD: Torrent ID ${torrentId}`);

    // Get torrent info to find files
    const torrentInfo = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { 
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 5000
      }
    );

    // Select all files
    const files = torrentInfo.data?.files;
    if (!files || files.length === 0) {
      console.log('RD: No files');
      return null;
    }

    const fileIds = files.map((f, i) => i + 1).join(',');
    console.log(`RD: Selecting files: ${fileIds}`);

    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      `files=${fileIds}`,
      { 
        headers: { 
          'Authorization': `Bearer ${apiKey}`, 
          'Content-Type': 'application/x-www-form-urlencoded' 
        },
        timeout: 5000
      }
    );

    // Wait for processing
    console.log('RD: Waiting for processing...');
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      
      const info = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { 
          headers: { 'Authorization': `Bearer ${apiKey}` },
          timeout: 5000
        }
      );
      
      console.log(`RD: Status: ${info.data?.status}, Links: ${info.data?.links?.length || 0}`);
      
      if (info.data?.links?.[0]) {
        // Unrestrict first link
        console.log('RD: Unrestricting link...');
        const unrestrict = await axios.post(
          'https://api.real-debrid.com/rest/1.0/unrestrict/link',
          `link=${encodeURIComponent(info.data.links[0])}`,
          { 
            headers: { 
              'Authorization': `Bearer ${apiKey}`, 
              'Content-Type': 'application/x-www-form-urlencoded' 
            },
            timeout: 5000
          }
        );
        
        if (unrestrict.data?.download) {
          console.log('RD: ✅ Success!');
          return unrestrict.data.download;
        }
      }
    }
    
    console.log('RD: Timeout waiting for links');
    return null;
  } catch (err) {
    console.error('RealDebrid error:', err.response?.status, err.response?.data || err.message);
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

  // Získat RD klíč z transportUrl nebo args.config
  let rdKey = REALDEBRID_API_KEY;
  
  // Zkusit získat z transport URL (Stremio ho tam dává)
  if (args.transportUrl) {
    const match = args.transportUrl.match(/[?&]rd=([^&]+)/);
    if (match) rdKey = decodeURIComponent(match[1]);
  }
  
  // Fallback na args.config
  if (!rdKey && args.config?.rd) {
    rdKey = args.config.rd;
  }
  
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  
  console.log('Creating streams with RD key:', rdKey ? 'yes' : 'no');
  console.log('Transport URL:', args.transportUrl?.substring(0, 100));
  console.log('Args config:', JSON.stringify(args.config));
  console.log('Base URL:', baseUrl);

  return {
    streams: torrents.filter(t => t.magnet).map(t => {
      if (rdKey) {
        const streamUrl = `${baseUrl}/rd/${encodeURIComponent(t.magnet)}?key=${encodeURIComponent(rdKey)}`;
        console.log('Stream URL:', streamUrl.substring(0, 100) + '...');
        return {
          name: 'Nyaa + RealDebrid',
          title: `🎬 ${t.name}\n👥 ${t.seeders} | 📦 ${t.filesize}`,
          url: streamUrl,
          behaviorHints: {
            bingeGroup: 'nyaa-rd'
          }
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

// Redirect root to index.html (must be BEFORE static middleware)
app.get('/', (req, res, next) => {
  // Only redirect if accept header suggests browser (not Stremio API call)
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next(); // Let SDK handle API calls to /
});

// Custom manifest endpoint pro ukládání RD klíče
app.get('/manifest.json', (req, res, next) => {
  if (req.query.rd) {
    // Uložit RD klíč spojený s tímto request
    const rdKey = req.query.rd;
    const userAgent = req.headers['user-agent'] || 'unknown';
    rdKeyCache.set(userAgent, rdKey);
    console.log(`💾 Saved RD key for ${userAgent.substring(0, 30)}`);
  }
  next(); // Pokračovat na SDK manifest handler
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// RealDebrid callback
app.get('/rd/:magnet', async (req, res) => {
  console.log('🔴 RD callback called!');
  console.log('Magnet param length:', req.params.magnet?.length);
  console.log('Query key:', req.query.key ? 'provided' : 'missing');
  
  const apiKey = req.query.key || REALDEBRID_API_KEY;
  if (!apiKey) {
    console.log('❌ No API key');
    return res.status(400).send('API key required');
  }
  
  const stream = await getRealDebridStream(decodeURIComponent(req.params.magnet), apiKey);
  if (stream) {
    console.log('✅ Redirecting to stream');
    res.redirect(stream);
  } else {
    console.log('❌ RD failed');
    res.status(500).send('Failed');
  }
});

// Start server
const addonRouter = getRouter(builder.getInterface());

// Mount addon routes manually (without SDK landing page)
app.use(addonRouter);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📺 Addon: http://localhost:${PORT}/manifest.json`);
  console.log(`🌐 Setup: http://localhost:${PORT}/`);
});
