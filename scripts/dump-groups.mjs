
import fs from 'fs';
const API_URL = 'https://whatsapp-news-bot-3-69qh.onrender.com';
const USER = 'anashreporter';
const PASS = 'HJkNHX0Fs9CJZ-i3HBdgl_bWzd9Ew_1o';
const AUTH = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');

async function main() {
    console.log('Fetching groups from:', API_URL);

    try {
        const res = await fetch(`${API_URL}/api/whatsapp/groups`, {
            headers: { 'Authorization': AUTH }
        });

        if (!res.ok) {
            console.error('Failed to fetch groups:', res.status, await res.text());
            return;
        }

        const groups = await res.json();
        console.log(`Fetched ${groups.length} groups.`);

        fs.writeFileSync('live_groups.json', JSON.stringify(groups, null, 2));
        console.log('Saved to live_groups.json');

    } catch (err) {
        console.error('Error:', err.message);
    }
}

main();
