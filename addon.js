const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();

// --- DŮLEŽITÁ OPRAVA PRO HTTPS ---
app.set('trust proxy', true);
// -------------------------------

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Konfigurace Addonu
// ZMĚNA: Přidáno 'stream' do resources
const ADDON_CONFIG = {
    id: 'org.anilist.stream.today',
    version: '3.0.0',
    name: 'AniList Dnes + Nyaa Streamy',
    description: 'Metadata z AniList + Živé streamy z Nyaa',
    logo: 'https://anilist.co/img/icons/android-icon-192x192.png',
    background: 'https://anilist.co/img/logo_al.png',
    resources: ['catalog', 'meta', 'stream'], // PŘIDÁN STREAM
    types: ['series'],
    catalogs: [{
        type: 'series',
        id: 'anilist_today',
        name: 'Dnes vychází (Streamy)',
        extra: [{ name: 'search', isRequired: false }] 
    }]
};

let animeCache = { data: [], timestamp: 0, ttl: 20 * 60 * 1000 };

// --- Keep-Alive (Render) ---
async function keepAlive() {
    try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        await axios.get(`${baseUrl}/health`, { timeout: 5000 });
        console.log(`🏓 Keep-alive ping úspěšný`);
    } catch (error) {
        console.log(`⚠️ Keep-alive ping selhal`);
    }
}
setInterval(keepAlive, 10 * 60 * 1000);

// --- AniList GraphQL API (Metadata) ---
async function fetchAiringToday() {
    const now = Date.now();
    
    if (animeCache.data.length > 0 && (now - animeCache.timestamp) < animeCache.ttl) {
        return animeCache.data;
    }

    try {
        const d = new Date();
        const startOfDayUTC = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const todayStart = Math.floor(startOfDayUTC.getTime() / 1000) - 3600;
        const todayEnd = todayStart + 86400; 

        console.log(`🕒 Dotazuji AniList (Časové okno pro CET): ${todayStart} - ${todayEnd}`);

        const query = `
            query ($from: Int, $to: Int) {
                Page(page: 1, perPage: 30) {
                    pageInfo { total }
                    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
                        airingAt
                        episode
                        media {
                            id
                            title { romaji, english, native }
                            description
                            coverImage { extraLarge, large, color }
                            bannerImage
                            genres
                            averageScore
                            format
                            status
                            episodes
                            seasonYear
                            studios { nodes { name } }
                        }
                    }
                }
            }
        `;

        const response = await axios.post('https://graphql.anilist.co', {
            query: query,
            variables: { from: todayStart, to: todayEnd }
        }, {
            headers: { 
                'Content-Type': 'application/json', 
                'Accept': 'application/json',
                'User-Agent': 'Stremio-AniList-Addon/3.0'
            }
        });

        const schedule = response.data.data.Page.airingSchedules;
        
        if (!schedule || schedule.length === 0) {
            console.log('📭 Dnes dle AniList nevychází nic.');
            return [{
                id: 'anilist-empty',
                name: 'Dnes nic nevychází',
                poster: 'https://via.placeholder.com/300x400/000000/FFFFFF?text=Žádné+anime',
                isPlaceholder: true,
                episode: 0
            }];
        }

        // Používáme AniList ID (nechceme se bavit s IMDB/MAL, protože hledáme sami)
        const animeList = schedule.map(item => {
            const media = item.media;
            const title = media.title.romaji || media.title.english;
            const safeEpisode = item.episode || 1;
            
            console.log(`📦 ${title} (Ep ${safeEpisode}) připraven`);

            return {
                id: `anilist-${media.id}`, 
                anilistId: media.id,
                name: title,
                romaji: media.title.romaji, // Pro vyhledávání důležité
                english: media.title.english,
                episode: safeEpisode,
                airingAt: item.airingAt,
                poster: media.coverImage.extraLarge || media.coverImage.large,
                background: media.bannerImage || media.coverImage.extraLarge,
                description: (media.description || '').replace(/<[^>]*>?/gm, '').substring(0, 800), 
                genres: media.genres,
                rating: media.averageScore,
                year: media.seasonYear,
                studio: media.studios.nodes.map(n => n.name).join(', '),
                totalEpisodes: media.episodes,
                isPlaceholder: false
            };
        });

        animeCache.data = animeList;
        animeCache.timestamp = now;
        console.log(`✅ Načteno ${animeList.length} seriálů z AniList`);
        return animeList;

    } catch (error) {
        console.error('❌ AniList Error:', error.message);
        return [{
            id: 'anilist-error',
            name: 'Chyba API',
            poster: 'https://via.placeholder.com/300x400/FF0000/FFFFFF?text=Chyba',
            isPlaceholder: true,
            episode: 0
        }];
    }
}

// --- NYAA STREAM LOGIKA ---
async function findStreamOnNyaa(animeName, episode) {
    try {
        // Sestavíme dotaz: "Název Anime - Epizoda" nebo "Název Anime Epizoda"
        const searchQuery = encodeURIComponent(`${animeName} - ${episode}`);
        const rssUrl = `https://nyaa.si/?page=rss&q=${searchQuery}`;

        console.log(`🧲 Hledám stream na Nyaa: ${animeName} - ${episode}`);

        // Stáhneme RSS (timeout 8s)
        const response = await axios.get(rssUrl, { 
            timeout: 8000, 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        // Parsujeme XML pomocí Cheerio
        const $ = cheerio.load(response.data, { xmlMode: true });

        // vezmeme první výsledek (item)
        const firstItem = $('item').first();
        const title = firstItem.find('title').text();
        
        // Hledáme magnet link v <enclosure> nebo <link>
        let magnetUrl = firstItem.find('enclosure').attr('url');
        if (!magnetUrl) {
            // Fallback na link (torrent soubor), pokud chybí magnet
            magnetUrl = firstItem.find('link').text();
        }

        if (magnetUrl) {
            console.log(`✅ Nalezen magnet: ${title}`);
            return [{
                name: '🧲 Nyaa Stream',
                title: title,
                url: magnetUrl
            }];
        }

        return []; // Nenašli jsme

    } catch (error) {
        console.log(`⚠️ Nyaa Search Error (${animeName}):`, error.message);
        return [];
    }
}

// --- ROUTES ---

app.get('/', (req, res) => {
    const baseUrl = req.protocol + '://' + req.get('host');
    res.send(`<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <title>AniList + Nyaa Addon</title>
    <style>
        body { font-family: sans-serif; background: #121212; color: #fff; text-align: center; padding: 40px; }
        h1 { color: #60a5fa; margin-bottom: 10px; }
        .box { background: #1e1e1e; padding: 30px; border-radius: 15px; display: inline-block; margin-top: 20px; border: 1px solid #333; }
        .code { color: #a5f3fc; font-family: monospace; background: #000; padding: 10px 15px; border-radius: 6px; font-size: 1.1em; display: block; margin: 15px 0; }
        a.btn { color: #121212; background: #60a5fa; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; margin-top: 10px; }
        a.btn:hover { background: #3b82f6; }
    </style>
</head>
<body>
    <h1>AniList + Nyaa Streamy</h1>
    <p>Metadata z AniList, Streamy z Nyaa RSS</p>
    <div class="box">
        <div>Manifest URL:</div>
        <div class="code">${baseUrl}/manifest.json</div>
        <a href="stremio://${req.get('host')}/manifest.json" class="btn">🚀 Instalovat do Stremio</a>
    </div>
</body>
</html>`);
});

app.get('/manifest.json', (req, res) => res.json(ADDON_CONFIG));

const sendCatalog = async (res) => {
    try {
        const animeList = await fetchAiringToday();
        const metas = animeList.map(anime => ({
            id: anime.id, // anilist-12345
            type: 'series',
            name: anime.name,
            poster: anime.poster,
            background: anime.background,
            description: anime.isPlaceholder 
                ? 'Žádný obsah' 
                : `📺 Epizoda ${anime.episode} • ${anime.genres?.join(', ') || ''} • ⭐ ${anime.rating || 0}/100`,
            genres: anime.genres
        }));
        return res.json({ metas });
    } catch (error) {
        console.error('Route Error:', error);
        if (!res.headersSent) return res.status(500).json({ metas: [] });
    }
};

app.get('/catalog/:type/:id.json', async (req, res) => {
    if (req.params.id === 'anilist_today') return sendCatalog(res);
    return res.json({ metas: [] });
});

app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
    if (req.params.id === 'anilist_today') return sendCatalog(res);
    return res.json({ metas: [] });
});

app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        const animeId = req.params.id;
        
        if (animeId.startsWith('anilist-')) {
            const animeList = await fetchAiringToday();
            const anime = animeList.find(a => a.id === animeId);

            if (anime) {
                if (anime.isPlaceholder) return res.json({ meta: null });

                const validEpisode = parseInt(anime.episode);
                if (isNaN(validEpisode)) return res.status(404).json({ meta: null });

                const videoId = `${anime.id}:1:${validEpisode}`;
                const airTime = new Date(anime.airingAt * 1000).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

                return res.json({
                    meta: {
                        id: anime.id,
                        type: 'series',
                        name: anime.name,
                        poster: anime.poster,
                        background: anime.background,
                        description: `${anime.description}\n\n\n📺 Dnes vychází epizoda: **${validEpisode}**\n⏰ Čas: ${airTime}\n⭐ Hodnocení: ${anime.rating}/100\n🎬 Studio: ${anime.studio}`,
                        genres: anime.genres,
                        releaseInfo: anime.year ? anime.year.toString() : '',
                        videos: [{
                            id: videoId,
                            title: `Epizoda ${validEpisode}`,
                            season: 1,
                            episode: validEpisode,
                            released: new Date(anime.airingAt * 1000).toISOString(),
                            overview: `Dnes vychází epizoda ${validEpisode} ze ${anime.totalEpisodes || '?'}.`,
                            thumbnail: anime.poster
                        }]
                    }
                });
            }
        }
        return res.status(404).json({ meta: null });
    } catch (error) {
        console.error('Meta Route Error:', error);
        if (!res.headersSent) return res.status(500).json({ meta: null });
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const videoId = req.params.id;
        // ID formát: anilist-12345:1:24
        const parts = videoId.split(':');
        const animeId = parts[0]; // anilist-12345

        if (animeId.startsWith('anilist-')) {
            const animeList = await fetchAiringToday();
            const anime = animeList.find(a => a.id === animeId);

            if (anime && !anime.isPlaceholder) {
                console.log(`🔍 Žádost o stream pro: ${anime.name} E${anime.episode}`);
                
                // ŽIVÉ VYHLEDÁNÍ NA NYAA
                const streams = await findStreamOnNyaa(anime.romaji || anime.name, anime.episode);

                if (streams.length > 0) {
                    return res.json({ streams });
                } else {
                    // Fallback: Pokud Nyaa nic nenašlo, vrátíme odkaz na web pro ruční vyhledání
                    const fallbackUrl = `https://nyaa.si/?q=${encodeURIComponent(anime.romaji + ' ' + anime.episode)}`;
                    return res.json({
                        streams: [{
                            name: '🔍 Hledat na Nyaa Manuálně',
                            title: 'Torrent automaticky nenalezen, zkuste vyhledat ručně',
                            url: fallbackUrl,
                            behaviorHints: { notWebReady: true }
                        }]
                    });
                }
            }
        }
        return res.json({ streams: [] });
    } catch (error) {
        console.error('Stream Route Error:', error);
        if (!res.headersSent) return res.status(500).json({ streams: [] });
    }
});

app.get('/health', (req, res) => {
    return res.json({ status: 'ok', cacheSize: animeCache.data.length });
});

app.use((err, req, res, next) => {
    console.error('Global Error:', err);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 AniList + Nyaa Addon běží na portu ${PORT}`);
    setTimeout(keepAlive, 2 * 60 * 1000);
});