const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const xml2js = require('xml2js');
const cron = require('node-cron');

const PORT = process.env.PORT || 7000;
const REALDEBRID_API_KEY = process.env.REALDEBRID_API_KEY || '';

let todayAnimeCache = [];

const manifest = {
  id: 'cz.anime.nyaa.direct',
  version: '3.2.0',
  name: 'Anime Today + Nyaa',
  description: 'Dnešní anime s přímými streamy z Nyaa přes RealDebrid',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  catalogs: [
    {
      type: 'series',
      id: 'anime-today-nyaa',
      name: 'Dnešní Anime (Nyaa)'
    }
  ],
  idPrefixes: ['nyaa:']
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
  try {
    const cleanName = animeName
      .replace(/Season \d+/i, '')
      .replace(/Part \d+/i, '')
      .replace(/2nd Season/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    const searchQuery = `${cleanName} ${episode}`.trim();
    const rssUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(searchQuery)}&c=1_2&f=0`;
    
    console.log(`Nyaa search: "${searchQuery}"`);
    
    const response = await axios.get(rssUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'Stremio-Anime-Addon/3.0' }
    });

    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(response.data);

    if (!result.rss?.channel?.[0]?.item) {
      console.log('No items in RSS');
      return [];
    }

    const torrents = result.rss.channel[0].item.map(item => {
      const link = item.link?.[0] || '';
      const nyaaId = link.match(/\/view\/(\d+)/)?.[1];
      
      return {
        title: item.title?.[0] || '',
        nyaaId: nyaaId,
        torrentUrl: nyaaId ? `https://nyaa.si/download/${nyaaId}.torrent` : null,
        size: item['nyaa:size']?.[0] || 'Unknown',
        seeders: parseInt(item['nyaa:seeders']?.[0] || 0)
      };
    });

    const valid = torrents.filter(t => t.torrentUrl).sort((a, b) => b.seeders - a.seeders);
    console.log(`Found ${valid.length} torrents`);
    return valid;
  } catch (error) {
    console.error('Nyaa error:', error.message);
    return [];
  }
}

async function getRealDebridStream(torrentUrl) {
  if (!REALDEBRID_API_KEY) {
    console.log('No RealDebrid API key');
    return null;
  }

  try {
    console.log(`RealDebrid: Downloading torrent...`);
    
    // 1. Stáhnout torrent soubor
    const torrentResponse = await axios.get(torrentUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': 'Stremio-Anime-Addon/3.0' }
    });

    const torrentBuffer = Buffer.from(torrentResponse.data);
    const torrentBase64 = torrentBuffer.toString('base64');

    console.log(`RealDebrid: Uploading to RD...`);

    // 2. Nahrát do RealDebrid
    const uploadResponse = await axios.put(
      'https://api.real-debrid.com/rest/1.0/torrents/addTorrent',
      torrentBase64,
      {
        headers: {
          'Authorization': `Bearer ${REALDEBRID_API_KEY}`,
          'Content-Type': 'application/x-bittorrent'
        },
        timeout: 10000
      }
    );

    if (!uploadResponse.data?.id) {
      console.log('RealDebrid: Upload failed');
      return null;
    }

    const torrentId = uploadResponse.data.id;
    console.log(`RealDebrid: Torrent ID ${torrentId}`);

    // 3. Vybrat všechny soubory
    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      'files=all',
      {
        headers: {
          'Authorization': `Bearer ${REALDEBRID_API_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 5000
      }
    );

    console.log(`RealDebrid: Waiting for processing...`);

    // 4. Počkat na zpracování (až 10 sekund)
    let links = null;
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      const infoResponse = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        {
          headers: { 'Authorization': `Bearer ${REALDEBRID_API_KEY}` },
          timeout: 5000
        }
      );

      if (infoResponse.data?.links?.[0]) {
        links = infoResponse.data.links;
        break;
      }
    }

    if (!links || links.length === 0) {
      console.log('RealDebrid: No links available');
      return null;
    }

    console.log(`RealDebrid: Got ${links.length} links, unrestricting...`);

    // 5. Unrestrict první link
    const unrestrictResponse = await axios.post(
      'https://api.real-debrid.com/rest/1.0/unrestrict/link',
      `link=${encodeURIComponent(links[0])}`,
      {
        headers: {
          'Authorization': `Bearer ${REALDEBRID_API_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 5000
      }
    );

    if (unrestrictResponse.data?.download) {
      console.log(`✅ RealDebrid: Success!`);
      return unrestrictResponse.data.download;
    }

    console.log('RealDebrid: No download link');
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
    console.log('Anime not found');
    return { streams: [] };
  }

  const animeName = schedule.media.title.romaji || schedule.media.title.english;
  
  // 1. Najít torrenty na Nyaa (rychle, bez stahování)
  const torrents = await searchNyaa(animeName, episode);

  if (torrents.length === 0) {
    console.log('No torrents found');
    return { streams: [] };
  }

  const streams = [];

  // 2. Pro každý torrent vytvořit stream s "internalUrl"
  // Když uživatel klikne, Stremio zavolá naši URL a my teprve pak zpracujeme RealDebrid
  for (const torrent of torrents) {
    if (REALDEBRID_API_KEY) {
      // S RealDebrid: přidat stream který při kliknutí spustí RD
      streams.push({
        name: 'Nyaa + RealDebrid',
        title: `🎬 ${torrent.title}\n👥 ${torrent.seeders} seeders | 📦 ${torrent.size}`,
        // externalUrl přesměruje na callback endpoint který zpracuje RD
        externalUrl: `${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/rd/${encodeURIComponent(torrent.torrentUrl)}`
      });
    } else {
      // Bez RealDebrid: jen torrent link
      streams.push({
        name: 'Nyaa (Torrent)',
        title: `${torrent.title}\n👥 ${torrent.seeders} seeders | 📦 ${torrent.size}`,
        url: torrent.torrentUrl,
        behaviorHints: {
          notWebReady: true
        }
      });
    }
  }

  console.log(`Returning ${streams.length} streams`);
  return { streams };
});

// RealDebrid callback endpoint
const express = require('express');
const app = express();

app.get('/rd/:torrentUrl', async (req, res) => {
  const torrentUrl = decodeURIComponent(req.params.torrentUrl);
  console.log(`RD callback: ${torrentUrl}`);
  
  const streamUrl = await getRealDebridStream(torrentUrl);
  
  if (streamUrl) {
    res.redirect(streamUrl);
  } else {
    res.status(500).send('RealDebrid failed');
  }
});

// Spustit Stremio addon na stejném portu
serveHTTP(builder.getInterface(), { port: PORT, server: app });

console.log(`🚀 Anime Today + Nyaa běží na portu ${PORT}`);
console.log(`📺 Manifest: http://localhost:${PORT}/manifest.json`);
console.log(`🔑 RealDebrid: ${REALDEBRID_API_KEY ? '✅ Aktivní' : '❌ Neaktivní'}`);
