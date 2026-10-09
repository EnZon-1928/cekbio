// file: index.js
const { exec } = require('child_process');
const { runMainMenu } = require('./io/menu');
const { state, saveReport } = require('./core/state');

const isAndroid = process.platform === 'android';

// 1. smart sensor: only execute if the os is android (termux)
if (isAndroid) {
    exec('termux-wake-lock', (err) => {
        if (!err) console.log('\n[+] android wake-lock active.');
    });
}

// 2. global airbag: sweep and emergency brake on ctrl+c
const emergencyStop = () => {
    // force dump remaining memory to disk if the engine is currently scanning targets
    if (state.activeTargetFile) {
        console.log('\n[!] emergency stop triggered (ctrl+c).');
        console.log('[!] [memory dump] saving remaining ram data to disk...');
        saveReport();
    }

    if (isAndroid) {
        exec('termux-wake-unlock', () => {
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
};

process.on('SIGINT', emergencyStop); // absolute ctrl+c interceptor

// absolute fatal error catchers to prevent force close
process.on('uncaughtException', (e) => {
    console.log('\n[!] fatal uncaught exception:\n', e.stack);
});

process.on('unhandledRejection', (e) => {
    console.log('\n[!] absolute unhandled rejection:\n', e.stack);
});

// execute main entry point
if (process.argv[2] === 'web' || process.argv[2] === 'local') {
    const runTelegram = process.argv[2] === 'local';
    if (runTelegram) require('dotenv').config();
    const { startWebServer } = require('./web/server');
    const configuredPort = process.env.PORT ? Number(process.env.PORT) : 3000;
    if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
        console.error('PORT must be an integer from 0 to 65535.');
        process.exitCode = 1;
    } else {
        startWebServer(configuredPort).then(async server => {
            if (!runTelegram) return;

            const { startTelegramBot } = require('./telegram/bot');
            const address = server.address();
            try {
                let telegramBot = null;
                server.once('close', () => telegramBot?.stop());
                telegramBot = await startTelegramBot({
                    token: process.env.TELEGRAM_BOT_TOKEN,
                    ownerId: process.env.TELEGRAM_OWNER_ID,
                    baseUrl: `http://127.0.0.1:${address.port}`,
                    onError: () => {
                        console.error('Telegram polling stopped. Check connectivity and bot configuration.');
                        server.close();
                    }
                });
                console.log('Dashboard and Telegram bot are running in the same local process.');
            } catch (error) {
                server.close();
                console.error(error.message || 'failed to start the local Telegram bot.');
                process.exitCode = 1;
            }
        }).catch((e) => {
            console.error('failed to start local web server:', e.stack || e);
            process.exitCode = 1;
        });
    }
} else {
    runMainMenu();
}