const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// --- DŮLEŽITÁ OPRAVA PRO HTTPS ---
app.set('trust proxy', true);
// -------------------------------

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Konfigurace Addonu
const ADDON_CONFIG = {
    id: 'org.mal.today.stremio',
    version: '1.0.0',
    name: 'MAL Dnes (Metadata)',
    description: 'Katalog anime vycházejících dnes - MyAnimeList API',
    logo: 'https://cdn.myanimelist.net/img/sp/icon/apple-touch-icon-256.png',
    background: 'https://cdn.myanimelist.net/images/mal-header.png',
    resources: ['catalog', 'meta'], 
    types: ['series'],
    catalogs: [{
        type: 'series',
        id: 'mal_today',
        name: 'Dnes vychází (MAL)',
        extra: [{ name: 'search', isRequired: false }] 
    }]
};

// Cache (30 minut - Jikan má limity)
let animeCache = { data: [], timestamp: 0, ttl: 30 * 60 * 1000 };

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

// --- MyAnimeList (Jikan) API ---
async function fetchAiringToday() {
    const now = Date.now();
    if (animeCache.data.length > 0 && (now - animeCache.timestamp) < animeCache.ttl) {
        return animeCache.data;
    }

    try {
        // 1. Zjistíme, jaký je dnes den v Japonsku (JST = UTC+9)
        // Protože anime vysílají v Japonsku, musíme znát jejich den.
        const date = new Date();
        const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
        const jstOffset = 9;
        const jstDate = new Date(utc + (3600000 * jstOffset));
        
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const todayDay = days[jstDate.getDay()]; // např. 'tuesday'

        console.log(`🕒 Dnes v Japonsku (JST) je: ${todayDay.toUpperCase()}`);

        // 2. Dotaz na Jikan API (Schedule endpoint)
        // Limitujeme na 25 položek pro rychlost a bezpečnost rate-limitu
        const url = `https://api.jikan.moe/v4/schedules/${todayDay}?filter=tv&limit=25&sfw=true`;
        
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Stremio-MAL-Addon/1.0' 
            }
        });

        const schedule = response.data.data;
        
        if (!schedule || schedule.length === 0) {
            console.log('📭 Dnes dle MAL nic nevychází.');
            return [{
                id: 'mal:empty',
                name: 'Dnes nic nevychází',
                poster: 'https://via.placeholder.com/300x400/000000/FFFFFF?text=Žádné+anime',
                isPlaceholder: true,
                malId: 0
            }];
        }

        const animeList = schedule.map(item => {
            const data = item.data; // Jikan vrací data uvnitř pole
            
            // ID prefixujeme jako 'mal:'
            return {
                id: `mal:${data.mal_id}`,
                malId: data.mal_id,
                name: data.title,
                poster: data.images.jpg.large_image_url,
                background: data.images.jpg.large_image_url, // MAL často nemá banner v schedule, použijeme poster
                description: (data.synopsis || 'Popis není k dispozici.').replace(/<[^>]*>?/gm, '').substring(0, 800),
                genres: data.genres.map(g => g.name),
                rating: data.score ? (data.score * 10) : 0, // MAL score je 0-10, Stremio chce často 0-100
                year: data.year,
                studio: data.studios.map(s => s.name).join(', '),
                totalEpisodes: data.episodes,
                isPlaceholder: false,
                // Poznámka: MAL schedule endpoint neříká přesné číslo dnešní epizody, jen že to běží.
                // Proto zobrazíme obecný text.
                episodeText: 'Nová Epizoda' 
            };
        });

        animeCache.data = animeList;
        animeCache.timestamp = now;
        console.log(`✅ Načteno ${animeList.length} seriálů z MAL (Jikan)`);
        return animeList;

    } catch (error) {
        console.error('❌ MAL (Jikan) Error:', error.message);
        // Jikan API je často plný (Rate Limit 429), vracíme fallback
        return [{
            id: 'mal:error',
            name: 'MAL API Přetíženo',
            poster: 'https://via.placeholder.com/300x400/FFA500/FFFFFF?text=API+Limit',
            isPlaceholder: true,
            malId: 0
        }];
    }
}

// --- ROUTES ---

app.get('/', (req, res) => {
    const baseUrl = req.protocol + '://' + req.get('host');
    res.send(`<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <title>MAL Metadata Addon</title>
    <style>
        body { font-family: sans-serif; background: #121212; color: #fff; text-align: center; padding: 40px; }
        h1 { color: #2e51a2; margin-bottom: 10px; }
        .box { background: #1e1e1e; padding: 30px; border-radius: 15px; display: inline-block; margin-top: 20px; border: 1px solid #333; }
        .code { color: #a5f3fc; font-family: monospace; background: #000; padding: 10px 15px; border-radius: 6px; font-size: 1.1em; display: block; margin: 15px 0; }
        a.btn { color: #fff; background: #2e51a2; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; margin-top: 10px; }
        a.btn:hover { background: #1e3d82; }
    </style>
</head>
<body>
    <h1>MyAnimeList Metadata Addon</h1>
    <p>Dnešní anime dle Japonska (JST)</p>
    <div class="box">
        <div>Manifest URL:</div>
        <div class="code">${baseUrl}/manifest.json</div>
        <a href="stremio://${req.get('host')}/manifest.json" class="btn">🚀 Instalovat do Stremio</a>
    </div>
</body>
</html>`);
});

app.get('/manifest.json', (req, res) => res.json(ADDON_CONFIG));

// Katalog
app.get('/catalog/:type/:id.json', async (req, res) => {
    try {
        if (req.params.id === 'mal_today') {
            const animeList = await fetchAiringToday();
            const metas = animeList.map(anime => ({
                id: anime.id,
                type: 'series',
                name: anime.name,
                poster: anime.poster,
                background: anime.background,
                description: anime.isPlaceholder 
                    ? 'Žádný obsah' 
                    : `${anime.episodeText} • ${anime.genres?.join(', ') || ''} • ⭐ ${anime.rating || 0}/100`,
                genres: anime.genres
            }));
            return res.json({ metas });
        } else {
            return res.json({ metas: [] });
        }
    } catch (error) {
        console.error('Route Error:', error);
        if (!res.headersSent) return res.status(500).json({ metas: [] });
    }
});

app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
    // Stejná logika jako bez extra
    return app._router.handle(req, res); // Přepošleme na předchozí funkci, nebo ji zkopírujeme
});

// Kopie pro cestu s extra parametry (kvůli express routeru)
app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
    try {
        if (req.params.id === 'mal_today') {
            const animeList = await fetchAiringToday();
            const metas = animeList.map(anime => ({
                id: anime.id,
                type: 'series',
                name: anime.name,
                poster: anime.poster,
                background: anime.background,
                description: anime.isPlaceholder 
                    ? 'Žádný obsah' 
                    : `${anime.episodeText} • ${anime.genres?.join(', ') || ''} • ⭐ ${anime.rating || 0}/100`,
                genres: anime.genres
            }));
            return res.json({ metas });
        } else {
            return res.json({ metas: [] });
        }
    } catch (error) {
        console.error('Route Error:', error);
        if (!res.headersSent) return res.status(500).json({ metas: [] });
    }
});

// Detail
app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        const animeId = req.params.id;
        
        if (animeId.startsWith('mal:')) {
            const animeList = await fetchAiringToday();
            const anime = animeList.find(a => a.id === animeId);

            if (anime) {
                if (anime.isPlaceholder) {
                    return res.json({ meta: null });
                }

                // ID pro video (zachováme mal: id)
                const videoId = `${anime.id}:1:1`;
                
                // MAL API nevrací přesný čas epizody v schedule endpointu, jen den.
                return res.json({
                    meta: {
                        id: anime.id,
                        type: 'series',
                        name: anime.name,
                        poster: anime.poster,
                        background: anime.background,
                        description: `${anime.description}\n\n\n📺 ${anime.episodeText}\n⭐ Hodnocení: ${anime.rating}/100\n🎬 Studio: ${anime.studio}\n📅 Rok: ${anime.year}`,
                        genres: anime.genres,
                        releaseInfo: anime.year ? anime.year.toString() : '',
                        videos: [{
                            id: videoId,
                            title: `Dnes vychází`,
                            season: 1,
                            episode: 1, // V Schedule endpointu neznáme číslo, nastavíme 1
                            released: new Date().toISOString(),
                            overview: `${anime.name} má dnes v Japonsku premiéru.`,
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

app.get('/stream/:type/:id.json', (req, res) => {
    return res.json({ streams: [] });
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
    console.log(`🚀 MAL Metadata Addon běží na portu ${PORT}`);
    setTimeout(keepAlive, 2 * 60 * 1000);
});