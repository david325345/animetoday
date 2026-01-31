const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cron = require('node-cron');
const express = require('express');
const path = require('path');
const { si } = require('nyaapi');

const PORT = process.env.PORT || 7000;
const REALDEBRID_API_KEY = process.env.REALDEBRID_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

let todayAnimeCache = [];

const manifest = {
  id: 'cz.anime.nyaa.rd',
  version: '1.1.0',
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

const builder = new addonBuilder(manifest);

// ===== TMDB API =====
async function searchTMDB(animeName, year) {
  if (!TMDB_API_KEY) return null;
  
  try {
    const response = await axios.get('https://api.themoviedb.org/3/search/tv', {
      params: {
        api_key: TMDB_API_KEY,
        query: animeName,
        first_air_date_year: year
      },
      timeout: 5000
    });
    
    return response.data?.results?.[0]?.id || null;
  } catch (err) {
    console.error('TMDB search error:', err.message);
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
    
    // Vybrat nejlepší backdrop (nejčastěji en nebo bez jazyka)
    const backdrop = backdrops.find(b => b.iso_639_1 === 'en' || !b.iso_639_1) || backdrops[0];
    const poster = posters.find(p => p.iso_639_1 === 'en' || !p.iso_639_1) || posters[0];
    
    return {
      backdrop: backdrop ? `https://image.tmdb.org/t/p/w1280${backdrop.file_path}` : null,
      poster: poster ? `https://image.tmdb.org/t/p/w500${poster.file_path}` : null
    };
  } catch (err) {
    console.error('TMDB images error:', err.message);
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

// ===== Cache Update s TMDB =====
async function updateCache() {
  console.log('🔄 Updating cache with TMDB images...');
  const schedules = await getTodayAnime();
  
  // Pro každé anime získat TMDB obrázky
  for (const schedule of schedules) {
    const media = schedule.media;
    const englishTitle = media.title.english || media.title.romaji;
    const year = media.seasonYear;
    
    // Vyhledat na TMDB
    const tmdbId = await searchTMDB(englishTitle, year);
    if (tmdbId) {
      const images = await getTMDBImages(tmdbId);
      if (images) {
        // Uložit do média
        schedule.tmdbImages = images;
        console.log(`✅ TMDB images for: ${englishTitle}`);
      }
    }
    
    // Malá pauza aby TMDB API nebyla přetížená
    await new Promise(r => setTimeout(r, 300));
  }
  
  todayAnimeCache = schedules;
  console.log(`✅ Cache: ${todayAnimeCache.length} anime (with TMDB images)`);
}

// Aktualizovat každý den ve 4 ráno
cron.schedule('0 4 * * *', updateCache);
// A také při startu
updateCache();

// ===== Stremio Handlers =====
builder.defineCatalogHandler(async (args) => {
  if (args.type !== 'series' || args.id !== 'anime-today') return { metas: [] };
  if (parseInt(args.extra?.skip) > 0) return { metas: [] };

  return {
    metas: todayAnimeCache.map(s => {
      // Zajistit že poster je vždy validní URL
      let poster = s.tmdbImages?.poster || s.media.coverImage.extraLarge || s.media.coverImage.large;
      // Fallback placeholder pokud všechno selže
      if (!poster || poster === 'null' || poster === '') {
        poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
      }
      
      // Background s fallbackem
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
  if (!schedule) return { meta: null };

  const m = schedule.media;
  
  // Validace posteru
  let poster = schedule.tmdbImages?.poster || m.coverImage.extraLarge || m.coverImage.large;
  if (!poster || poster === 'null' || poster === '') {
    poster = 'https://via.placeholder.com/230x345/1a1a2e/ffffff?text=No+Image';
  }
  
  // Background s fallbackem
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

  const rdKey = REALDEBRID_API_KEY;
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

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

app.get('/', (req, res, next) => {
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/rd/:magnet', async (req, res) => {
  const apiKey = req.query.key || REALDEBRID_API_KEY;
  if (!apiKey) return res.status(400).send('API key required');
  
  const stream = await getRealDebridStream(decodeURIComponent(req.params.magnet), apiKey);
  stream ? res.redirect(stream) : res.status(500).send('Failed');
});

const addonRouter = getRouter(builder.getInterface());
app.use(addonRouter);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📺 Addon: http://localhost:${PORT}/manifest.json`);
  console.log(`🌐 Web: http://localhost:${PORT}/`);
  console.log(`🔑 RealDebrid: ${REALDEBRID_API_KEY ? '✅' : '❌'}`);
  console.log(`🎬 TMDB: ${TMDB_API_KEY ? '✅' : '❌'}`);
});
