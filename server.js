const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cron = require('node-cron');

const PORT = process.env.PORT || 7000;

let todayAnimeCache = [];
let lastUpdate = null;

const manifest = {
  id: 'cz.anime.anilist.catalog',
  version: '1.0.2',
  name: 'Anime Today Catalog',
  description: 'Katalog dnešních anime epizod z AniList',
  resources: ['catalog'],
  types: ['movie'],
  catalogs: [
    {
      type: 'movie',
      id: 'anime-today',
      name: 'Dnešní Anime Epizody'
    }
  ],
  idPrefixes: ['anilist:']
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
            episodes
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

    if (response.data && response.data.data) {
      return response.data.data.Page.airingSchedules || [];
    }
    return [];
  } catch (error) {
    console.error('Chyba při získávání dat z AniList:', error.message);
    return [];
  }
}

async function updateCache() {
  console.log('Aktualizace cache dnešních anime...');
  todayAnimeCache = await getTodayAnime();
  lastUpdate = new Date();
  console.log(`Cache aktualizována: ${todayAnimeCache.length} anime nalezeno`);
}

updateCache();
cron.schedule('*/15 * * * *', updateCache);

builder.defineCatalogHandler(async (args) => {
  if (args.type === 'movie' && args.id === 'anime-today') {
    const skip = parseInt(args.extra?.skip) || 0;
    
    if (skip > 0) {
      console.log(`Skip ${skip} - returning empty (no more pages)`);
      return { metas: [] };
    }
    
    const metas = todayAnimeCache.map(schedule => {
      const media = schedule.media;
      return {
        id: `anilist:${media.id}`,
        type: 'movie',
        name: `${media.title.romaji || media.title.english || media.title.native} - Epizoda ${schedule.episode}`,
        poster: media.coverImage.large,
        background: media.bannerImage,
        description: `Epizoda ${schedule.episode}\n\n${media.description ? media.description.replace(/<[^>]*>/g, '') : 'Bez popisu'}`,
        genres: media.genres || [],
        releaseInfo: media.seasonYear ? `${media.season} ${media.seasonYear}` : '',
        imdbRating: media.averageScore ? (media.averageScore / 10).toFixed(1) : undefined,
        runtime: `Episode ${schedule.episode}`
      };
    });

    console.log(`Returning ${metas.length} metas (skip=${skip})`);
    return { metas };
  }

  return { metas: [] };
});

serveHTTP(builder.getInterface(), { port: PORT });

console.log(`🚀 Anime Today Catalog běží na portu ${PORT}`);
console.log(`📺 Manifest: http://localhost:${PORT}/manifest.json`);
