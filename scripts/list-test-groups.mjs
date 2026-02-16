
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

        console.log('\nAll Groups:');
        groups.forEach(g => {
            console.log(`- [${g.id}] "${g.name || g.subject}" (Size: ${g.size || g.participantCount || '?'})`);
        });

    } catch (err) {
        console.error('Error:', err.message);
    }
}

main();
