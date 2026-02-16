
const API_URL = 'https://whatsapp-news-bot-3-69qh.onrender.com';
const USER = 'anashreporter';
const PASS = 'HJkNHX0Fs9CJZ-i3HBdgl_bWzd9Ew_1o';
const AUTH = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
const TARGET_JID = '120363407220244757@g.us'; // Feed for Anash WhatsApp

async function main() {
    console.log(`Sending test message to ${TARGET_JID}...`);

    try {
        const res = await fetch(`${API_URL}/api/whatsapp/send-test`, {
            method: 'POST',
            headers: {
                'Authorization': AUTH,
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
