const express = require('express');
const { serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const app = express();

// --- KONFIGURACE ---
const ADDON_NAME = "Anime Dnes (AniList)";
const ADDON_ID = "com.example.anilist-today";

// --- POMOCNÉ FUNKCE ---
function getTodayRangeJST() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const jstTime = new Date(utc + (3600000 * 9)); 
    
    jstTime.setHours(0, 0, 0, 0);
    const startOfDay = Math.floor(jstTime.getTime() / 1000);
    const endOfDay = startOfDay + 86400 - 1; 
    return { startOfDay, endOfDay };
}

// --- MANIFEST ---
const manifest = {
    id: ADDON_ID,
    version: '1.0.0',
    name: ADDON_NAME,
    description: 'Zobrazuje anime vysílaná dnes',
    resources: ['catalog', 'meta'],
    types: ['series'],
    catalogs: [
        {
            type: 'series',
            id: 'anilist-today',
            name: 'Anime Dnes',
            extra: [{ name: 'search' }]
        }
    ],
    idPrefixes: ['anilist:']
};

// --- HANDLERY ---
async function catalogHandler(args) {
    const { startOfDay, endOfDay } = getTodayRangeJST();

    const query = `
    query ($page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
            media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC) {
                id
                title { romaji }
                coverImage { large }
                nextAiringEpisode { airingAt episode }
                description
                genres
            }
        }
    }
    `;

    try {
        const response = await axios.post('https://graphql.anilist.co', {
            query: query,
            variables: { page: 1, perPage: 50 }
        });
        const allMedia = response.data.data.Page.media;
        const todayAnime = allMedia.filter(anime => {
            if (!anime.nextAiringEpisode) return false;
            const airingTime = anime.nextAiringEpisode.airingAt;
            return airingTime >= startOfDay && airingTime <= endOfDay;
        });
        const metas = todayAnime.map(anime => ({
            id: `anilist:${anime.id}`,
            type: 'series',
            name: anime.title.romaji,
            poster: anime.coverImage.large,
            description: `Další díl: Ep. ${anime.nextAiringEpisode.episode}\n\n${anime.description?.slice(0, 300)}...`,
            genres: anime.genres
        }));
        return { metas };
    } catch (error) {
        console.error("Chyba AniList:", error.message);
        return { metas: [] };
    }
}

async function metaHandler(args) {
    if (!args.id.startsWith('anilist:')) return { meta: null };
    const anilistId = args.id.split(':')[1];
    
    const query = `
    query ($id: Int) {
        Media(id: $id, type: ANIME) {
            id title { romaji english }
            coverImage { large extraLarge }
            bannerImage description genres averageScore status
        }
    }
    `;
    try {
        const response = await axios.post('https://graphql.anilist.co', {
            query: query,
            variables: { id: parseInt(anilistId) }
        });
        const data = response.data.data.Media;
        return {
            meta: {
                id: `anilist:${data.id}`, type: 'series', name: data.title.romaji,
                poster: data.coverImage.large, background: data.bannerImage,
                description: data.description, genres: data.genres,
                rating: data.averageScore ? (data.averageScore / 10).toFixed(1) : null,
                runtime: 24
            }
        };
    } catch (error) {
        return { meta: null };
    }
}

// --- SERVER SETUP ---
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.get('/', (req, res) => res.send('Stremio Addon běží'));

// TOTO JE ZMĚNA PRO SDK 1.5.0 - serveHTTP správně namapované
app.use('/', serveHTTP(manifest, { catalog: catalogHandler, meta: metaHandler }));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));