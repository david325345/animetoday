const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();

app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ADDON_CONFIG = {
    id: 'org.anilist.stream.today',
    version: '4.1.0',
    name: 'AniList Dnes + Nyaa Final',
    description: 'Opravené vyhledávání - Bez poškození názvů',
    logo: 'https://anilist.co/img/icons/android-icon-192x192.png',
    background: 'https://anilist.co/img/logo_al.png',
    resources: ['catalog', 'meta', 'stream'], 
    types: ['series'],
    catalogs: [{
        type: 'series',
        id: 'anilist_today',
        name: 'Dnes vychází (Fixed Search)',
        extra: [{ name: 'search', isRequired: false }] 
    }]
};

let animeCache = { data: [], timestamp: 0, ttl: 20 * 60 * 1000 };

// --- Keep-Alive ---
async function keepAlive() {
    try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        await axios.get(`${baseUrl}/health`, { timeout: 5000 });
    } catch (error) {}
}
setInterval(keepAlive, 10 * 60 * 1000);

// --- AniList API ---
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
                'User-Agent': 'Stremio-AniList-Addon/4.1'
            }
        });

        const schedule = response.data.data.Page.airingSchedules;
        
        if (!schedule || schedule.length === 0) {
            return [{
                id: 'anilist-empty',
                name: 'Dnes nic nevychází',
                poster: 'https://via.placeholder.com/300x400/000000/FFFFFF?text=Žádné+anime',
                isPlaceholder: true,
                episode: 0
            }];
        }

        const animeList = schedule.map(item => {
            const media = item.media;
            const title = media.title.romaji || media.title.english;
            const safeEpisode = item.episode ||1;
            
            return {
                id: `anilist-${media.id}`, 
                name: title,
                romaji: media.title.romaji, // POUŽÍVÁME PŘESNÝ NÁZEV
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

// --- NYAA FINAL SEARCH LOGIC ---
async function findStreamOnNyaa(animeRomaji, animeEnglish, episode) {
    
    const performSearch = async (query) => {
        const rssUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&s=seeders&o=desc`;
        console.log(`🔍 Dotazuji Nyaa: "${query}"`);

        try {
            const response = await axios.get(rssUrl, { 
                timeout: 8000, 
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            const $ = cheerio.load(response.data, { xmlMode: true });
            const results = [];
            
            $('item').each((index, element) => {
                if (index >= 5) return false;
                const $el = $(element);
                const title = $el.find('title').text();
                let magnetUrl = $el.find('enclosure').attr('url');
                if (!magnetUrl) {
                    const linkUrl = $el.find('link').text();
                    if (linkUrl && linkUrl.includes('magnet')) magnetUrl = linkUrl;
                }
                if (magnetUrl) {
                    results.push({ title, url: magnetUrl });
                }
            });
            return results;
        } catch (error) {
            return [];
        }
    };

    const episodeStr = episode.toString();

    // --- STRATEGIE 1: PŘÍMÝ DOTAZ (Romaji) ---
    // Nepoužíváme čištění (sanitization), jen čistý název z AniList
    let streams = await performSearch(`${animeRomaji} - ${episodeStr}`);

    // --- STRATEGIE 2: PřÍMÝ DOTAZ (English) ---
    if (streams.length === 0 && animeEnglish) {
        console.log(`🔄 Romaji nic, zkouším English...`);
        streams = await performSearch(`${animeEnglish} - ${episodeStr}`);
    }

    // --- STRATEGIE 3: FALLBACK S VYHLEDAVÁNÍM JEN JMÉNA ---
    // Tohle je klíčový moment, kde se hledalo špatně.
    // Nyní použijeme REGEX pro bezpečné vyfiltrování epizody.
    if (streams.length === 0) {
        console.log(`🔄 Přímé dotazy selhaly, zkouším Fallback (Jen jméno + Regex)...`);
        
        // Získáme výsledky jen pro jméno anime (např. 20 výsledků)
        let rawResults = await performSearch(animeRomaji);
        
        if (rawResults.length === 0 && animeEnglish) {
            rawResults = await performSearch(animeEnglish);
        }

        // --- REGEX FILTR ---
        // Hledáme číslo epizody, které je "oddělené" mezerou, pomlčkou, tečkou nebo závorkou.
        // Zabrání to nalezení "2" v "24".
        const episodeRegex = new RegExp(`[^0-9]${episodeStr}[^0-9]`, 'i');
        
        streams = rawResults.filter(item => {
            return episodeRegex.test(item.title);
        });

        if (streams.length > 0) {
            console.log(`✅ Fallback našel ${streams.length} výsledků přes Regex.`);
        }
    }

    if (streams.length > 0) {
        return streams.map(item => {
            let quality = 'Torrent';
            const t = item.title;
            if (t.includes('1080p')) quality = '1080p';
            else if (t.includes('720p')) quality = '720p';
            else if (t.includes('480p')) quality = '480p';
            return {
                name: `🧲 Nyaa ${quality}`,
                title: item.title,
                url: item.url
            };
        });
    }

    return [];
}

// --- ROUTES ---

app.get('/', (req, res) => {
    const baseUrl = req.protocol + '://' + req.get('host');
    res.send(`<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <title>AniList + Nyaa Final</title>
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
    <h1>AniList + Nyaa Final</h1>
    <p>Opravené vyhledávání s Regex fallbackem</p>
    <div class="box">
        <div>Manifest URL:</div>
        <div class="code">${baseUrl}/manifest.json</div>
        <a href="stremio://${req.get('host')}/manifest.json" class="btn">🚀 Instalovat</a>
    </div>
</body>
</html>`);
});

app.get('/manifest.json', (req, res) => res.json(ADDON_CONFIG));

const sendCatalog = async (res) => {
    try {
        const animeList = await fetchAiringToday();
        const metas = animeList.map(anime => ({
            id: anime.id,
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

            if (anime && !anime.isPlaceholder) {
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
        if (!res.headersSent) return res.status(500).json({ meta: null });
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const videoId = req.params.id;
        const parts = videoId.split(':');
        const animeId = parts[0];

        if (animeId.startsWith('anilist-')) {
            const animeList = await fetchAiringToday();
            const anime = animeList.find(a => a.id === animeId);

            if (anime && !anime.isPlaceholder) {
                // VOLÁME FINÁLNÍ HLEDÁNÍ
                const streams = await findStreamOnNyaa(anime.romaji || anime.name, anime.english, anime.episode);

                if (streams.length > 0) {
                    return res.json({ streams });
                } else {
                    return res.json({
                        streams: [{
                            name: '❌ Torrent nenalezen',
                            title: 'Vyhledáno i s Fallback strategií',
                            url: 'data:text/plain,Not Available'
                        }]
                    });
                }
            }
        }
        return res.json({ streams: [] });
    } catch (error) {
        console.error('Stream Error:', error);
        if (!res.headersSent) return res.status(500).json({ streams: [] });
    }
});

app.get('/health', (req, res) => {
    return res.json({ status: 'ok', cacheSize: animeCache.data.length });
});

app.use((err, req, res, next) => {
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 AniList + Nyaa Final Addon běží na portu ${PORT}`);
    setTimeout(keepAlive, 2 * 60 * 1000);
});