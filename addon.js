const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const xml2js = require('xml2js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Konfigurace addonu
const ADDON_CONFIG = {
    id: 'org.anilist.nyaa.stremio',
    version: '1.0.1',
    name: 'AniList Trending (Nyaa)',
    description: 'Aktuálně populární anime z AniList s automatickým vyhledáním torrentů na Nyaa.si',
    logo: 'https://anilist.co/img/icons/android-chrome-192x192.png',
    background: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/101922-9qZ35Y4775yB.jpg',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    catalogs: [{
        type: 'series',
        id: 'anilist_trending',
        name: 'Trending & Airing'
    }]
};

// Cache pro AniList data (14 minut)
let animeCache = { data: [], timestamp: 0, ttl: 14 * 60 * 1000 };

// Keep-alive ping funkce (zabrání uspání na Render.com)
async function keepAlive() {
    try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        await axios.get(`${baseUrl}/health`, { timeout: 5000 });
        console.log(`🏓 Keep-alive ping úspěšný`);
    } catch (error) {
        console.log(`⚠️ Keep-alive ping selhal:`, error.message);
    }
}

setInterval(keepAlive, 10 * 60 * 1000);

// --- FUNKCE PRO ZÍSKÁNÍ DAT ---

async function fetchAniListTrending() {
    const now = Date.now();
    // Použijeme cache, pokud je platná
    if (animeCache.data.length > 0 && (now - animeCache.timestamp) < animeCache.ttl) {
        return animeCache.data;
    }

    try {
        // Dotaz na AniList API
        const query = `
            query {
                Page(page: 1, perPage: 25) {
                    media(type: ANIME, sort: POPULARITY_DESC, status: RELEASING) {
                        id
                        title { romaji english }
                        description
                        coverImage { large color }
                        genres
                        startDate { year month day }
                        episodes
                    }
                }
            }
        `;

        const response = await axios.post('https://graphql.anilist.co', { query });
        const mediaList = response.data.data.Page.media;

        // Transformace dat do formátu pro Stremio
        const metas = mediaList.map(m => ({
            id: `anilist:${m.id}`,
            name: m.title.romaji || m.title.english,
            poster: m.coverImage.large,
            background: m.coverImage.large, // Později můžeme hledat banner
            description: m.description ? m.description.replace(/<br>/g, '\n').substring(0, 500) + '...' : 'Popis není dostupný.',
            genres: m.genres,
            releaseInfo: `${m.startDate.year}`,
            episodes: m.episodes
        }));

        animeCache.data = metas;
        animeCache.timestamp = now;
        return metas;

    } catch (error) {
        console.error('Chyba při načítání AniList:', error.message);
        return [];
    }
}

async function searchNyaaTorrents(animeName) {
    try {
        // Vytvoříme vyhledávací dotaz na Nyaa RSS
        // Hledáme: Název Anime + "1080p", seřazeno podle seedů
        const searchQuery = `${animeName} 1080p`;
        const rssUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(searchQuery)}&s=seeders&o=desc`;

        const response = await axios.get(rssUrl, {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        // Parsujeme XML
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);
        
        const streams = [];

        if (result.rss && result.rss.channel && result.rss.channel[0].item) {
            const items = result.rss.channel[0].item;

            items.forEach(item => {
                const title = item.title[0];
                const link = item.link[0]; // Magnet link nebo odkaz
                const nyaaInfo = item['nyaa:torrent'][0]['$'];
                
                // Získáme informace o souboru z RSS
                const size = nyaaInfo.size;
                const seeders = nyaaInfo.seeders;

                // Detekce kvality (pokud není v dotazu)
                const qualityMatch = title.match(/\[?(1080p|720p|480p)\]?/i);
                const quality = qualityMatch ? qualityMatch[1].toUpperCase() : 'HD';

                streams.push({
                    name: `[Nyaa] ${quality} | Seeds: ${seeders}`,
                    title: title,
                    url: link, // Nyaa RSS vrací magnet link přímo
                    behaviorHints: {
                        bingeGroup: `anilist-${animeName}`,
                        notWebReady: true // Torrenty nejsou přehratelné přímo v prohlížeči
                    }
                });
            });
        }
        
        return streams;

    } catch (error) {
        console.error(`Chyba při hledání na Nyaa (${animeName}):`, error.message);
        return [];
    }
}

// --- ROUTES ---

// 1. Hlavní webová stránka (Instalační stránka)
app.get('/', (req, res) => {
    const baseUrl = req.protocol + '://' + req.get('host');
    
    res.send(`<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AniList Nyaa Addon</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #2b5876 0%, #4e4376 100%);
            min-height: 100vh; padding: 20px; color: white;
        }
        .container {
            max-width: 800px; margin: 0 auto;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(12px);
            border-radius: 20px; padding: 40px;
            box-shadow: 0 20px 50px rgba(0,0,0,0.4);
            border: 1px solid rgba(255,255,255,0.2);
        }
        .header { text-align: center; margin-bottom: 40px; }
        .logo {
            width: 90px; height: 90px;
            background: linear-gradient(45deg, #02aab0, #00cdac);
            border-radius: 25px; margin: 0 auto 20px;
            display: flex; align-items: center; justify-content: center;
            font-size: 40px; color: white;
            box-shadow: 0 10px 20px rgba(2, 170, 176, 0.3);
        }
        h1 { margin-bottom: 10px; font-size: 2.5rem; text-shadow: 0 2px 10px rgba(0,0,0,0.3); }
        .subtitle { font-size: 1.1rem; opacity: 0.9; font-weight: 300; }
        .status-box {
            padding: 20px; margin: 20px 0; border-radius: 15px;
            text-align: center; font-weight: 600;
            background: rgba(0, 255, 127, 0.15);
            border: 1px solid rgba(0, 255, 127, 0.4);
        }
        .install-section {
            background: rgba(0,0,0,0.2);
            padding: 30px; border-radius: 15px; margin: 30px 0;
            text-align: center; border: 1px solid rgba(255,255,255,0.1);
        }
        .url-box {
            background: rgba(0,0,0,0.4); padding: 15px; 
            border-radius: 8px; margin: 15px 0;
            word-break: break-all; font-family: monospace;
            border: 1px solid rgba(255,255,255,0.1);
            color: #4e4376; /* Dark text for readability inside box if bg was white, keeping light for this theme */
            color: #ffeb3b;
        }
        .btn {
            background: linear-gradient(45deg, #02aab0, #00cdac);
            color: white; border: none; padding: 14px 30px;
            border-radius: 50px; font-size: 16px; font-weight: 700;
            cursor: pointer; margin: 10px; text-decoration: none;
            display: inline-block; transition: transform 0.2s, box-shadow 0.2s;
            box-shadow: 0 5px 15px rgba(0, 205, 172, 0.4);
        }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0, 205, 172, 0.6); }
        .features-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0;
        }
        .feature-item {
            background: rgba(255,255,255,0.05); padding: 15px;
            border-radius: 10px; font-size: 0.9rem;
            display: flex; align-items: center; gap: 10px;
        }
        @media (max-width: 600px) {
            .features-grid { grid-template-columns: 1fr; }
            h1 { font-size: 2rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🎬</div>
            <h1>AniList + Nyaa</h1>
            <p class="subtitle">Automatický stremio addon pro aktuální anime</p>
        </div>

        <div class="status-box">
            ✅ Systém je online a funkční
        </div>

        <div class="install-section">
            <h2>📱 Instalace do Stremio</h2>
            <p style="margin-bottom: 10px; opacity: 0.8;">Klikněte na tlačítko níže pro přidání do Stremio:</p>
            <a href="stremio://${req.get('host')}/manifest.json" class="btn">🚀 Nainstalovat Addon</a>
            <div class="url-box">${baseUrl}/manifest.json</div>
        </div>

        <div class="features-grid">
            <div class="feature-item">
                <span>📅</span> Aktuálně vysílaná anime
            </div>
            <div class="feature-item">
                <span>🔍</span> Automatické hledání na Nyaa
            </div>
            <div class="feature-item">
                <span>🖼️</span> Postery z AniList
            </div>
            <div class="feature-item">
                <span>🏓</span> Anti-sleep pro Render
            </div>
        </div>
    </div>
</body>
</html>`);
});

// 2. Stremio Manifest
app.get('/manifest.json', (req, res) => res.json(ADDON_CONFIG));

// 3. Health (pro keep-alive)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        cacheSize: animeCache.data.length,
        cacheAge: Date.now() - animeCache.timestamp
    });
});

// 4. Catalog (Seznam anime)
app.get('/catalog/:type/:id.json', async (req, res) => {
    if (req.params.id === 'anilist_trending') {
        const metas = await fetchAniListTrending();
        res.json({ metas });
    } else {
        res.json({ metas: [] });
    }
});

app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
    if (req.params.id === 'anilist_trending') {
        const metas = await fetchAniListTrending();
        res.json({ metas });
    } else {
        res.json({ metas: [] });
    }
});

// 5. Meta (Detaily konkrétního anime)
app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        const id = req.params.id.replace('anilist:', '');
        const cachedList = await fetchAniListTrending();
        const item = cachedList.find(i => i.id === req.params.id);

        if (item) {
            // Vytvoříme "videos" objekt pro Stremio
            // Protože neznáme přesné číslo epizody, vytvoříme zástupce
            const videos = [];
            if (item.episodes) {
                for (let i = 1; i <= Math.min(item.episodes, 5); i++) {
                    videos.push({
                        id: `${item.id}:1:${i}`,
                        title: `Epizoda ${i}`,
                        season: 1,
                        episode: i,
                        released: new Date().toISOString(), // Simulace data vydání
                    });
                }
            } else {
                // Pokud je epizod "neurčité" nebo mnoho
                videos.push({
                    id: `${item.id}:1:1`,
                    title: `Průběžné vysílání`,
                    season: 1,
                    episode: 1,
                    released: new Date().toISOString(),
                });
            }

            res.json({
                meta: {
                    id: item.id,
                    type: 'series',
                    name: item.name,
                    poster: item.poster,
                    background: item.background,
                    description: item.description,
                    genres: item.genres,
                    releaseInfo: item.releaseInfo,
                    videos: videos
                }
            });
        } else {
            res.status(404).json({ error: 'Not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. Stream (Torrenty z Nyaa)
app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const videoId = req.params.id;
        // Rozdělíme ID, abychom získali ID anime (neepizody)
        // ID formát je obvykle anilist:123:1:1
        const animeId = videoId.split(':').slice(0, 2).join(':');

        const cachedList = await fetchAniListTrending();
        const item = cachedList.find(i => i.id === animeId);

        if (item) {
            // Hledáme na Nyaa
            const streams = await searchNyaaTorrents(item.name);
            
            if (streams.length === 0) {
                // Fallback stream, pokud se nic nenajde
                streams.push({
                    name: '🔍 Vyhledávání na Nyaa selhalo',
                    title: `Zkuste vyhledat ručně: ${item.name}`,
                    url: `https://nyaa.si/?q=${encodeURIComponent(item.name)}`,
                    behaviorHints: { notWebReady: true }
                });
            }
            
            res.json({ streams });
        } else {
            res.json({ streams: [] });
        }
    } catch (e) {
        res.status(500).json({ streams: [] });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server běží na portu ${PORT}`);
    console.log(`🎬 AniList + Nyaa addon připraven`);
    
    // Spustíme první ping po 5 minutách od startu
    setTimeout(() => {
        console.log(`🏓 Spouštím keep-alive systém...`);
        keepAlive();
    }, 5 * 60 * 1000); 
});