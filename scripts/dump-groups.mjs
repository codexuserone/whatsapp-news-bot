
import fs from 'fs';
import { loadApiAuth } from './lib/apiAuth.mjs';

const { apiUrl, authHeaders } = loadApiAuth();

async function main() {
    console.log('Fetching groups from:', apiUrl);

    try {
        const res = await fetch(`${apiUrl}/api/whatsapp/groups`, {
            headers: authHeaders
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
