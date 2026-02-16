
import { loadApiAuth } from './lib/apiAuth.mjs';

const { apiUrl, authHeaders } = loadApiAuth();
const TARGET_JID = String(process.env.TEST_TARGET_JID || '120363407220244757@g.us').trim();

async function main() {
    console.log(`Sending test message to ${TARGET_JID}...`);

    try {
        const res = await fetch(`${apiUrl}/api/whatsapp/send-test`, {
            method: 'POST',
            headers: {
                ...authHeaders,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jids: [TARGET_JID],
                message: 'Test message from Anash Bot [Automated Verification]'
            })
        });

        if (!res.ok) {
            console.error('Failed to send test:', res.status, await res.text());
            return;
        }

        const result = await res.json();
        console.log('Send result:', JSON.stringify(result, null, 2));

    } catch (err) {
        console.error('Error:', err.message);
    }
}

main();
