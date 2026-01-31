const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cron = require('node-cron');

const PORT = process.env.PORT || 7000;

let todayAnimeCache = [];

const manifest = {
  id: 'cz.anime.today',
  version: '2.0.0',
  name: 'Anime Today',
  description: 'Dnešní anime epizody z AniList',
  resources: ['catalog'],
  types: ['series'],
  catalogs: [
    {
      type: 'series',
      id: 'anime-today',
      name: 'Dnešní Anime Epizody'
    }
  ],
  idPrefixes: ['tt:', 'kitsu:', 'anilist:']
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
            idMal
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

// Najít Kitsu ID podle MAL ID
async function getKitsuId(malId) {
  if (!malId) return null;
  
  try {
    const response = await axios.get(`https://kitsu.io/api/edge/anime`, {
      params: {
        'filter[myAnimeListId]': malId
      },
      timeout: 5000
    });

    if (response.data?.data?.[0]?.id) {
      return response.data.data[0].id;
    }
    return null;
  } catch (error) {
    console.error(`Kitsu lookup failed for MAL ${malId}:`, error.message);
    return null;
  }
}

async function updateCache() {
  console.log('Aktualizace cache...');
  const schedules = await getTodayAnime();
  
  // Mapovat na Kitsu ID
  const animeWithKitsu = [];
  for (const schedule of schedules) {
    let kitsuId = null;
    
    if (schedule.media.idMal) {
      kitsuId = await getKitsuId(schedule.media.idMal);
    }
    
    animeWithKitsu.push({ 
      ...schedule, 
      kitsuId: kitsuId 
    });
    
    if (!kitsuId) {
      console.log(`⚠️ Kitsu ID nenalezeno: ${schedule.media.title.romaji}`);
    }
  }
  
  todayAnimeCache = animeWithKitsu;
  const withKitsu = animeWithKitsu.filter(a => a.kitsuId).length;
  console.log(`Cache: ${todayAnimeCache.length} anime (${withKitsu} s Kitsu ID)`);
}

updateCache();
cron.schedule('*/15 * * * *', updateCache);

builder.defineCatalogHandler(async (args) => {
  if (args.type === 'series' && args.id === 'anime-today') {
    const skip = parseInt(args.extra?.skip) || 0;
    
    if (skip > 0) {
      return { metas: [] };
    }
    
    const metas = todayAnimeCache.map(schedule => {
      const media = schedule.media;
      
      // Priorita: Kitsu ID > MAL ID > AniList ID
      let id;
      if (schedule.kitsuId) {
        id = `kitsu:${schedule.kitsuId}`;
      } else if (media.idMal) {
        id = `kitsu:${media.idMal}`;
      } else {
        id = `anilist:${media.id}`;
      }
      
      return {
        id: id,
        type: 'series',
        name: media.title.romaji || media.title.english || media.title.native,
        poster: media.coverImage.large,
        background: media.bannerImage,
        description: media.description ? media.description.replace(/<[^>]*>/g, '') : '',
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

serveHTTP(builder.getInterface(), { port: PORT });

console.log(`🚀 Anime Today běží na portu ${PORT}`);
console.log(`📺 Manifest: http://localhost:${PORT}/manifest.json`);
