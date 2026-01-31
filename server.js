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
  id: 'cz.anime.nyaa.direct',
  version: '4.0.1',
  name: 'Anime Today + Nyaa',
  description: 'Dnešní anime s Nyaa torrenty přes RealDebrid',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  catalogs: [
    {
      type: 'series',
      id: 'anime-today-nyaa',
      name: 'Dnešní Anime (Nyaa)'
    }
  ],
  idPrefixes: ['nyaa:'],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
};

const builder = new addonBuilder(manifest);

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
      query: query,
      variables: { weekStart: dayStart, weekEnd: dayEnd }
    });

    if (response.data?.data?.Page?.airingSchedules) {
      return response.data.data.Page.airingSchedules;
    }
    return [];
  } catch (error) {
    console.error('AniList error:', error.message);
    return [];
  }
}

async function searchNyaa(animeName, episode) {
  const searchVariants = [
    `${animeName} ${episode}`,
    `${animeName.split(':')[0].trim()} ${episode}`,
    `${animeName.replace(/Season \d+/i, '').replace(/Part \d+/i, '').trim()} ${episode}`
  ];

  for (const query of searchVariants) {
    try {
      console.log(`Nyaa API: "${query}"`);
      
      let allTorrents = [];
      
      for (let page = 1; page <= 2; page++) {
        try {
          const result = await si.searchPage(query, page, {
            filter: 0,
            category: '1_2'
          });
          
          if (result && result.length > 0) {
            allTorrents = allTorrents.concat(result);
          } else {
            break;
          }
        } catch (err) {
          console.error(`Page ${page} failed:`, err.message);
          break;
        }
      }

      if (allTorrents.length > 0) {
        const sorted = allTorrents.sort((a, b) => b.seeders - a.seeders);
        console.log(`✅ Found ${sorted.length} torrents`);
        return sorted;
      }
    } catch (error) {
      console.error(`Nyaa error for "${query}":`, error.message);
    }
  }

  console.log('No torrents found');
  return [];
}

async function getRealDebridStream(magnetUrl, apiKey) {
  if (!apiKey) {
    return null;
  }

  try {
    console.log(`RealDebrid: Adding magnet...`);
    
    const addResponse = await axios.post(
      'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnetUrl)}`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );

    if (!addResponse.data?.id) {
      return null;
    }

    const torrentId = addResponse.data.id;

    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      'files=all',
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 5000
      }
    );

    let links = null;
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      const infoResponse = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          timeout: 5000
        }
      );

      if (infoResponse.data?.links?.[0]) {
        links = infoResponse.data.links;
        break;
      }
    }

    if (!links || links.length === 0) {
      return null;
    }

    const unrestrictResponse = await axios.post(
      'https://api.real-debrid.com/rest/1.0/unrestrict/link',
      `link=${encodeURIComponent(links[0])}`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 5000
      }
    );

    if (unrestrictResponse.data?.download) {
      console.log(`✅ RealDebrid: Success!`);
      return unrestrictResponse.data.download;
    }

    return null;
  } catch (error) {
    console.error('RealDebrid error:', error.message);
    return null;
  }
}

async function updateCache() {
  console.log('Aktualizace cache...');
  todayAnimeCache = await getTodayAnime();
  console.log(`Cache: ${todayAnimeCache.length} anime`);
}

updateCache();
cron.schedule('*/15 * * * *', updateCache);

builder.defineCatalogHandler(async (args) => {
  if (args.type === 'series' && args.id === 'anime-today-nyaa') {
    const skip = parseInt(args.extra?.skip) || 0;
    
    if (skip > 0) {
      return { metas: [] };
    }
    
    const metas = todayAnimeCache.map(schedule => {
      const media = schedule.media;
      const id = `nyaa:${media.id}:${schedule.episode}`;
      
      return {
        id: id,
        type: 'series',
        name: media.title.romaji || media.title.english || media.title.native,
        poster: media.coverImage.large,
        background: media.bannerImage,
        description: `Epizoda ${schedule.episode}\n\n${media.description ? media.description.replace(/<[^>]*>/g, '') : ''}`,
        genres: media.genres || [],
        releaseInfo: `${media.season || ''} ${media.seasonYear || ''} - Ep ${schedule.episode}`.trim(),
        imdbRating: media.averageScore ? (media.averageScore / 10).toFixed(1) : undefined
      };
    });

    console.log(`Catalog: ${metas.length} metas`);
    return { metas };
  }

  return { metas: [] };
});

builder.defineMetaHandler(async (args) => {
  const idParts = args.id.split(':');
  
  if (idParts[0] !== 'nyaa' || idParts.length !== 3) {
    return { meta: null };
  }

  const anilistId = parseInt(idParts[1]);
  const episode = parseInt(idParts[2]);

  const schedule = todayAnimeCache.find(s => 
    s.media.id === anilistId && s.episode === episode
  );

  if (!schedule) {
    return { meta: null };
  }

  const media = schedule.media;

  return {
    meta: {
      id: args.id,
      type: 'series',
      name: media.title.romaji || media.title.english || media.title.native,
      poster: media.coverImage.large,
      background: media.bannerImage,
      description: media.description ? media.description.replace(/<[^>]*>/g, '') : '',
      genres: media.genres || [],
      releaseInfo: `${media.season || ''} ${media.seasonYear || ''} - Epizoda ${schedule.episode}`.trim(),
      imdbRating: media.averageScore ? (media.averageScore / 10).toFixed(1).toString() : undefined,
      videos: [
        {
          id: args.id,
          title: `Epizoda ${schedule.episode}`,
          episode: schedule.episode,
          season: 1,
          released: new Date(schedule.airingAt * 1000).toISOString()
        }
      ]
    }
  };
});

builder.defineStreamHandler(async (args) => {
  console.log('Stream request:', args.id);
  
  const idParts = args.id.split(':');
  
  if (idParts[0] !== 'nyaa' || idParts.length !== 3) {
    return { streams: [] };
  }

  const anilistId = parseInt(idParts[1]);
  const episode = parseInt(idParts[2]);

  const schedule = todayAnimeCache.find(s => 
    s.media.id === anilistId && s.episode === episode
  );

  if (!schedule) {
    return { streams: [] };
  }

  const media = schedule.media;
  const animeName = media.title.romaji || media.title.english || media.title.native;
  const animeNameEn = media.title.english || media.title.romaji || media.title.native;
  
  let torrents = await searchNyaa(animeName, episode);
  
  if (torrents.length === 0 && animeNameEn !== animeName) {
    torrents = await searchNyaa(animeNameEn, episode);
  }

  if (torrents.length === 0) {
    return { streams: [] };
  }

  const streams = [];
  const userRdKey = args.config?.rd || REALDEBRID_API_KEY;

  for (const torrent of torrents) {
    if (!torrent.magnet) continue;

    if (userRdKey) {
      streams.push({
        name: 'Nyaa + RealDebrid',
        title: `🎬 ${torrent.name}\n👥 ${torrent.seeders} seeders | 📦 ${torrent.filesize}`,
        externalUrl: `${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/rd/${encodeURIComponent(torrent.magnet)}?key=${encodeURIComponent(userRdKey)}`
      });
    } else {
      streams.push({
        name: 'Nyaa (Magnet)',
        title: `${torrent.name}\n👥 ${torrent.seeders} seeders | 📦 ${torrent.filesize}`,
        url: torrent.magnet,
        behaviorHints: {
          notWebReady: true
        }
      });
    }
  }

  console.log(`Returning ${streams.length} streams`);
  return { streams };
});

// Express server pro custom routes
const app = express();

// Servovat static soubory z public
app.use('/setup', express.static(path.join(__dirname, 'public')));

// RealDebrid callback
app.get('/rd/:magnetUrl', async (req, res) => {
  const magnetUrl = decodeURIComponent(req.params.magnetUrl);
  const apiKey = req.query.key || REALDEBRID_API_KEY;
  
  if (!apiKey) {
    return res.status(400).send('RealDebrid API key required');
  }
  
  const streamUrl = await getRealDebridStream(magnetUrl, apiKey);
  
  if (streamUrl) {
    res.redirect(streamUrl);
  } else {
    res.status(500).send('RealDebrid failed');
  }
});

// Použít serveHTTP s naším Express serverem
serveHTTP(builder.getInterface(), { port: PORT, server: app });

console.log(`🚀 Anime Today + Nyaa běží na portu ${PORT}`);
console.log(`📺 Manifest: http://localhost:${PORT}/manifest.json`);
console.log(`🌐 Setup: http://localhost:${PORT}/setup/`);
console.log(`🔑 RealDebrid: ${REALDEBRID_API_KEY ? '✅ Aktivní' : '❌ Neaktivní'}`);
