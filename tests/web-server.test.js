const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startWebServer } = require('../web/server');

test('sender health endpoint returns cached status without probing sessions', async t => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cekbio-web-health-'));
    process.chdir(temporaryDirectory);
    const server = await startWebServer(0);

    t.after(async () => {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
        process.chdir(originalDirectory);
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/senders/health?refresh=0`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { senders: [], checking: false });
});
