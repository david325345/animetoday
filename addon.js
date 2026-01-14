const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// --- DŮLEŽITÁ OPRAVA PRO HTTPS NA RENDER ---
// Říká Expressu, aby věřil hlavičkám z Render proxy (X-Forwarded-Proto).
// Díky tomu req.protocol vrátí "https" místo "http".
app.set('trust proxy', true);
// -------------------------------------------

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Konfigurace Addonu
const ADDON_CONFIG = {
    id: 'org.anilist.meta.today',
    version: '1.0.0',
    name: 'AniList Dnes (Metadata)',
    description: 'Katalog anime vycházejících dnes - pouze metadata',
    logo: 'https://anilist.co/img/icons/android-icon-192x192.png',
    background: 'https://anilist.co/img/logo_al.png',
    resources: ['catalog', 'meta'], 
    types: ['series'],
    catalogs: [{
        type: 'series',
        id: 'anilist_today',
        name: 'Dnes vychází (AniList)',
        extra: [{ name: 'search', isRequired: false }] 
    }]
};

// Cache (20 minut)
let animeCache = { data: [], timestamp: 0, ttl: 20 * 60 * 1000 };

// --- Keep-Alive (Render) ---
async function keepAlive() {
    try {
        // Používáme RENDER_EXTERNAL_URL, pokud existuje, pro správné pingování
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        await axios.get(`${baseUrl}/health`, { timeout: 5000 });
        console.log(`🏓 Keep-alive ping`);
    } catch (error) {
        console.log(`⚠️ Keep-alive selhal`);
    }
}
setInterval(keepAlive, 10 * 60 * 1000);

// --- AniList API ---
async function fetchAiringToday() {
    const now = Date.now();
    if (animeCache.data.length > 0 && (now - animeCache.timestamp) < animeCache.ttl) {
        return animeCache.data;
    }

    try {
        const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
        const todayEnd = Math.floor(new Date().setHours(23, 59, 59, 999) / 1000);

        const query = `
            query ($from: Int, $to: Int) {
                Page(page: 1, perPage: 50) {
                    airingSchedule(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
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
                            tags { nodes { name } }
                        }
                    }
                }
            }
        `;

        const response = await axios.post('https://graphql.anilist.co', {
            query: query,
            variables: { from: todayStart, to: todayEnd }
        }, {
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });

        const schedule = response.data.data.Page.airingSchedule;
        
        if (!schedule || schedule.length === 0) {
            return [{
                id: 'anilist:empty',
                name: 'Dnes nic nevychází',
                poster: 'https://via.placeholder.com/300x400/000000/FFFFFF?text=Žádné+anime',
                isPlaceholder: true
            }];
        }

        const animeList = schedule.map(item => {
            const media = item.media;
            const title = media.title.english || media.title.romaji;
            
            return {
                id: `anilist:${media.id}`, 
                anilistId: media.id,
                name: title,
                romaji: media.title.romaji,
                native: media.title.native,
                episode: item.episode,
                airingAt: item.airingAt,
                poster: media.coverImage.extraLarge || media.coverImage.large,
                background: media.bannerImage || media.coverImage.extraLarge,
                description: (media.description || '').replace(/<[^>]*>?/gm, '').substring(0, 1000), 
                genres: media.genres,
                rating: media.averageScore,
                year: media.seasonYear,
                studio: media.studios.nodes.map(n => n.name).join(', '),
                tags: media.tags.nodes.map(n => n.name).join(', '),
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
            id: 'anilist:error',
            name: 'Chyba API',
            poster: 'https://via.placeholder.com/300x400/FF0000/FFFFFF?text=Chyba',
            isPlaceholder: true
        }];
    }
}

// --- ROUTES ---

app.get('/', (req, res) => {
    // Díky app.set('trust proxy', true) bude baseUrl správně https
    const baseUrl = req.protocol + '://' + req.get('host');
    res.send(`<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AniList Metadata</title>
    <style>
        body { font-family: sans-serif; background: #121212; color: #fff; text-align: center; padding: 40px; }
        h1 { color: #60a5fa; }
        .box { background: #1e1e1e; padding: 20px; border-radius: 10px; display: inline-block; margin-top: 20px; }
        .code { color: #a5f3fc; font-family: monospace; background: #000; padding: 5px 10px; border-radius: 4px; }
        .secure { color: #4ade80; margin-top: 10px; font-size: 0.9em; }
    </style>
</head>
<body>
    <h1>AniList Metadata Addon</h1>
    <div class="secure" id="protocol-check">Detekovaný protokol: ...</div>
    <p>Tento addon poskytuje pouze metadata (katalog, popisky, obrázky).</p>
    <div class="box">
        <p>Instalační URL:</p>
        <div class="code">${baseUrl}/manifest.json</div>
        <br><br>
        <a href="stremio://${req.get('host')}/manifest.json" style="color:#121212; background:#60a5fa; padding:10px 20px; text-decoration:none; border-radius:5px;">Instalovat</a>
    </div>
    <script>
        document.getElementById('protocol-check').innerText = "Detekovaný protokol: " + window.location.protocol;
    </script>
</body>
</html>`);
});

app.get('/manifest.json', (req, res) => res.json(ADDON_CONFIG));

// Katalog - Hlavní cesta
app.get('/catalog/:type/:id.json', async (req, res) => {
    if (req.params.id === 'anilist_today') {
        const animeList = await fetchAiringToday();
        
        const metas = animeList.map(anime => ({
            id: anime.id,
            type: 'series',
            name: anime.name,
            poster: anime.poster,
            background: anime.background,
            description: anime.isPlaceholder ? 'Žádný obsah' : `${anime.genres?.join(', ')} • Rating: ${anime.rating}`,
            genres: anime.genres
        }));
        
        res.json({ metas });
    } else {
        res.json({ metas: [] });
    }
});

// Katalog - Cesta s extra parametry
app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
    if (req.params.id === 'anilist_today') {
        const animeList = await fetchAiringToday();
        
        const metas = animeList.map(anime => ({
            id: anime.id,
            type: 'series',
            name: anime.name,
            poster: anime.poster,
            background: anime.background,
            description: anime.isPlaceholder ? 'Žádný obsah' : `${anime.genres?.join(', ')} • Rating: ${anime.rating}`,
            genres: anime.genres
        }));
        
        res.json({ metas });
    } else {
        res.json({ metas: [] });
    }
});

app.get('/meta/:type/:id.json', async (req, res) => {
    const animeId = req.params.id;
    
    if (animeId.startsWith('anilist:')) {
        const animeList = await fetchAiringToday();
        const anime = animeList.find(a => a.id === animeId);

        if (anime) {
            if (anime.isPlaceholder) {
                return res.json({ meta: null });
            }

            const videoId = `${anime.id}:1:${anime.episode}`;
            
            const airTime = new Date(anime.airingAt * 1000).toLocaleTimeString('cs-CZ', { 
                hour: '2-digit', minute: '2-digit' 
            });

            res.json({
                meta: {
                    id: anime.id,
                    type: 'series',
                    name: anime.name,
                    poster: anime.poster,
                    background: anime.background,
                    description: `${anime.description}\n\n\n📺 Vychází dnes v ${airTime} (UTC)\n⭐ Hodnocení: ${anime.rating}/100\n🎬 Studio: ${anime.studio}`,
                    genres: anime.genres,
                    releaseInfo: anime.year ? anime.year.toString() : '',
                    videos: [{
                        id: videoId,
                        title: `Epizoda ${anime.episode}`,
                        season: 1,
                        episode: parseInt(anime.episode),
                        released: new Date(anime.airingAt * 1000).toISOString(),
                        overview: `Dnes vychází epizoda ${anime.episode} ze ${anime.totalEpisodes || '?'}.`,
                        thumbnail: anime.poster
                    }]
                }
            });
        }
    }
    res.status(404).json({ meta: null });
});

app.get('/stream/:type/:id.json', (req, res) => {
    res.json({ streams: [] });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', cacheSize: animeCache.data.length });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Metadata Addon běží na portu ${PORT}`);
    setTimeout(keepAlive, 2 * 60 * 1000);
});