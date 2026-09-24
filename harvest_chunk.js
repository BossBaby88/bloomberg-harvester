const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');

const YEAR = process.argv[2] || '2014';
const MONTH = process.argv[3] || '2';
const PART = process.argv[4] || '1'; // 1 = jours 1-15, 2 = jours 16-fin

const OUTPUT_DIR = path.resolve(__dirname, `./output_${YEAR}_${MONTH}_part${PART}`);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function cleanTicker(raw) {
    try { return decodeURIComponent(raw).split('/')[0].trim(); } catch (e) { return raw; }
}

function slugify(text) {
    if (!text) return 'article';
    return text.toString().toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').slice(0, 60);
}

function parseBloombergBody(node) {
    let text = '', tickers = [];
    if (!node) return { text, tickers };
    if (node.value) text += node.value;
    const bbg = node.data?.destination?.bbg || node.data?.href;
    if (bbg && bbg.startsWith('bbg://securities/')) tickers.push(cleanTicker(bbg.replace('bbg://securities/', '')));
    if (node.content && Array.isArray(node.content)) {
        for (const child of node.content) {
            const res = parseBloombergBody(child);
            if (text && res.text && !text.endsWith(' ') && !res.text.startsWith(' ') && !/^[.,;:!?'")\]]/.test(res.text)) text += ' ';
            text += res.text;
            tickers.push(...res.tickers);
        }
        if (node.type === 'paragraph') text += '\n\n';
    }
    return { text: text.replace(/[ \t]+/g, ' ').replace(/\n\s+\n/g, '\n\n').trim(), tickers: [...new Set(tickers)] };
}

async function run() {
    const monthKey = `${YEAR}-${parseInt(MONTH, 10)}`;
    const sitemapUrl = `https://www.bloomberg.com/sitemaps/news/${monthKey}.xml`;

    console.log(`\n🚀 [Runner Cloud] Démarrage : Année ${YEAR} | Mois ${MONTH} | Partie ${PART}`);

    const browser = await firefox.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0'
    });
    const page = await context.newPage();

    // Bloquer les traceurs
    await page.route('**/*', route => {
        const u = route.request().url();
        if (u.includes('perimeterx') || u.includes('px-cloud') || u.includes('px.js') || u.includes('advertising') || u.includes('analytics')) return route.abort();
        return route.continue();
    });

    try {
        console.log(`📥 Téléchargement du sitemap : ${sitemapUrl}...`);
        await page.goto(sitemapUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const xml = await page.content();
        const urls = (xml.match(/<loc>(https?:\/\/[^\s<>]+)<\/loc>/gi) || []).map(u => u.replace(/<\/?loc>/g, '').trim());
        const allArticles = urls.filter(u => u.includes('/news/articles/') || u.includes('/news/features/'));

        // Filtrage des jours
        const filteredUrls = allArticles.filter(url => {
            const dateMatch = url.match(/\/(\d{4})-(\d{2})-(\d{2})\//);
            if (!dateMatch) return PART === '1';
            const dayNum = parseInt(dateMatch[3], 10);
            return PART === '1' ? (dayNum <= 15) : (dayNum > 15);
        });

        console.log(`🎯 ${filteredUrls.length} dépêches assignées à ce runner.\n`);

        let saved = 0;
        for (let i = 0; i < filteredUrls.length; i++) {
            const url = filteredUrls[i];
            const slug = url.split('/').pop();
            const filePath = path.join(OUTPUT_DIR, `${slugify(slug)}.json`);

            if (fs.existsSync(filePath)) {
                console.log(`   ⏭️  [${i + 1}/${filteredUrls.length}] Déjà fait : ${slug.slice(0, 35)}...`);
                continue;
            }

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const rawData = await page.evaluate(() => {
                    const s = document.getElementById('__NEXT_DATA__');
                    return s ? JSON.parse(s.innerText) : null;
                });

                if (rawData) {
                    const story = rawData.props?.pageProps?.story || rawData.props?.pageProps?.article;
                    if (story) {
                        const parsed = parseBloombergBody(story.body);
                        if (parsed.text && parsed.text.length > 200) {
                            fs.writeFileSync(filePath, JSON.stringify({
                                url, title: story.headline || story.title,
                                summary: story.summary || "", publishedAt: story.publishedAt || monthKey,
                                fullText: parsed.text, tickers: parsed.tickers
                            }, null, 2));
                            saved++;
                            console.log(`   ✅ [${i + 1}/${filteredUrls.length}] Sauvegardé (${Math.round(parsed.text.length / 1024)} KB) : ${slug.slice(0, 40)}...`);
                        } else {
                            console.log(`   ⚠️  [${i + 1}/${filteredUrls.length}] Format court : ${slug.slice(0, 40)}...`);
                        }
                    }
                }
            } catch (e) {
                console.log(`   ❌ [${i + 1}/${filteredUrls.length}] Erreur : ${e.message.slice(0, 40)}`);
            }

            // Pause aléatoire de sécurité (2 à 4 secondes)
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 2000 + 2000)));
        }
        console.log(`\n🎉 [Runner Terminé] Total de ${saved} articles sauvegardés pour ce lot.`);
    } catch (e) {
        console.error("Erreur générale :", e.message);
    }

    await browser.close();
}

run();
