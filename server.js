const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const xml2js = require('xml2js');
const cron = require('node-cron');

const PORT = process.env.PORT || 7000;
const REALDEBRID_API_KEY = process.env.REALDEBRID_API_KEY || '';

let todayAnimeCache = [];

const manifest = {
  id: 'cz.anime.nyaa.direct',
  version: '3.0.0',
  name: 'Anime Today + Nyaa',
  description: 'Dnešní anime s přímými streamy z Nyaa',
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

// Získat dnešní anime z AniList
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

// Vyhledat na Nyaa a získat magnet linky
async function searchNyaaWithMagnets(animeName, episode) {
  try {
    const cleanName = animeName
      .replace(/Season \d+/i, '')
      .replace(/Part \d+/i, '')
      .replace(/2nd Season/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    const searchQuery = `${cleanName} ${episode}`.trim();
    const rssUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(searchQuery)}&c=1_2&f=0`;
    
    console.log(`Nyaa: "${searchQuery}"`);
    
    const response = await axios.get(rssUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'Stremio-Anime-Addon/3.0' }
    });

    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(response.data);

    if (!result.rss?.channel?.[0]?.item) {
      return [];
    }

    const torrents = result.rss.channel[0].item.map(item => {
      const link = item.link?.[0] || '';
      const nyaaId = link.match(/\/view\/(\d+)/);
      
      // Zkusit získat magnet přímo z GUID nebo description
      let magnetUrl = null;
      
      // Nyaa RSS má torrent link v guid nebo link
      if (item.guid?.[0]) {
        const guid = typeof item.guid[0] === 'string' ? item.guid[0] : item.guid[0]._;
        if (guid.includes('magnet:')) {
          magnetUrl = guid;
        }
      }
      
      // Fallback: vytvořit torrent download link
      if (!magnetUrl && nyaaId) {
        magnetUrl = `https://nyaa.si/download/${nyaaId[1]}.torrent`;
      }
      
      return {
        title: item.title?.[0] || '',
        nyaaId: nyaaId ? nyaaId[1] : null,
        magnetUrl: magnetUrl,
        size: item['nyaa:size']?.[0] || 'Unknown',
        seeders: parseInt(item['nyaa:seeders']?.[0] || 0)
      };
    });

    return torrents
      .filter(t => t.magnetUrl) // Jen torrenty s linkem
      .sort((a, b) => b.seeders - a.seeders)
      .slice(0, 10);
  } catch (error) {
    console.error('Nyaa error:', error.message);
    return [];
  }
}

// Získat magnet link z Nyaa stránky
async function getMagnetFromNyaa(nyaaId) {
  try {
    const response = await axios.get(`https://nyaa.si/view/${nyaaId}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Stremio-Anime-Addon/3.0' }
    });

    const magnetMatch = response.data.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"'\s]*/);
    if (magnetMatch) {
      return magnetMatch[0];
    }
    return null;
  } catch (error) {
    console.error(`Magnet error for ${nyaaId}:`, error.message);
    return null;
  }
}

// RealDebrid - přidat torrent a získat stream link
async function addToRealDebrid(magnetUrl) {
  if (!REALDEBRID_API_KEY) {
    return null;
  }

  try {
    // 1. Přidat magnet
    const addResponse = await axios.post(
      'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnetUrl)}`,
      {
        headers: {
          'Authorization': `Bearer ${REALDEBRID_API_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );

    if (!addResponse.data?.id) {
      return null;
    }

    const torrentId = addResponse.data.id;

    // 2. Vybrat všechny soubory
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

    // 3. Počkat chvíli na zpracování
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 4. Získat info o torrentu
    const infoResponse = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      {
        headers: { 'Authorization': `Bearer ${REALDEBRID_API_KEY}` },
        timeout: 5000
      }
    );

    if (!infoResponse.data?.links?.[0]) {
      return null;
    }

    // 5. Unrestrict první link
    const unrestrictResponse = await axios.post(
      'https://api.real-debrid.com/rest/1.0/unrestrict/link',
      `link=${encodeURIComponent(infoResponse.data.links[0])}`,
      {
        headers: {
          'Authorization': `Bearer ${REALDEBRID_API_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 5000
      }
    );

    if (unrestrictResponse.data?.download) {
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

// CATALOG - zobrazí dnešní anime
builder.defineCatalogHandler(async (args) => {
  if (args.type === 'series' && args.id === 'anime-today-nyaa') {
    const skip = parseInt(args.extra?.skip) || 0;
    
    if (skip > 0) {
      return { metas: [] };
    }
    
    const metas = todayAnimeCache.map(schedule => {
      const media = schedule.media;
      
      // Vlastní ID ve formátu nyaa:ANILIST_ID:EPISODE
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

// META - vrátí detail anime
builder.defineMetaHandler(async (args) => {
  console.log('Meta request:', args.id);
  
  const idParts = args.id.split(':');
  
  if (idParts[0] !== 'nyaa' || idParts.length !== 3) {
    return { meta: null };
  }

  const anilistId = parseInt(idParts[1]);
  const episode = parseInt(idParts[2]);

  // Najít anime v cache
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

// STREAM - najde torrenty na Nyaa
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
  const torrents = await searchNyaaWithMagnets(animeName, episode);

  if (torrents.length === 0) {
    console.log('No torrents found');
    return { streams: [] };
  }

  console.log(`Found ${torrents.length} torrents`);
  const streams = [];

  // Zpracovat všechny torrenty
  for (const torrent of torrents) {
    if (!torrent.nyaaId) continue;

    // Získat magnet link
    const magnetUrl = await getMagnetFromNyaa(torrent.nyaaId);
    if (!magnetUrl) {
      console.log(`No magnet for ${torrent.nyaaId}`);
      continue;
    }

    // Zkusit RealDebrid pokud je API klíč
    let streamUrl = magnetUrl;
    let name = 'Nyaa (Torrent)';
    
    if (REALDEBRID_API_KEY) {
      const rdUrl = await addToRealDebrid(magnetUrl);
      if (rdUrl) {
        streamUrl = rdUrl;
        name = 'Nyaa (RealDebrid)';
        console.log(`RealDebrid OK for ${torrent.title.substring(0, 50)}`);
      }
    }

    streams.push({
      name: name,
      title: `${torrent.title}\n👥 ${torrent.seeders} seeders | 📦 ${torrent.size}`,
      url: streamUrl,
      behaviorHints: {
        notWebReady: streamUrl === magnetUrl
      }
    });
  }

  console.log(`Returning ${streams.length} streams`);
  return { streams };
});

serveHTTP(builder.getInterface(), { port: PORT });

console.log(`🚀 Anime Today + Nyaa běží na portu ${PORT}`);
console.log(`📺 Manifest: http://localhost:${PORT}/manifest.json`);
console.log(`🔑 RealDebrid: ${REALDEBRID_API_KEY ? '✅ Aktivní' : '❌ Neaktivní (nastavte REALDEBRID_API_KEY)'}`);

