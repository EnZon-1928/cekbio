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

const stopLocalApplication = async telegramBot => {
    await telegramBot?.stop();
    if (isAndroid) {
        await new Promise(resolve => exec('termux-wake-unlock', resolve));
    }
    process.exit(0);
};

const runTelegramBot = async () => {
    require('dotenv').config();
    const { createLocalService } = require('./core/local-service');
    const { startTelegramBot } = require('./telegram/bot');
    let telegramBot = null;
    const service = createLocalService({
        onShutdown: () => stopLocalApplication(telegramBot)
    });

    try {
        telegramBot = await startTelegramBot({
            token: process.env.TELEGRAM_BOT_TOKEN,
            ownerId: process.env.TELEGRAM_OWNER_ID,
            service,
            onError: () => {
                console.error('Telegram polling stopped. Check connectivity and bot configuration.');
                void telegramBot?.stop();
                process.exitCode = 1;
            }
        });
        console.log('cekbio Telegram bot is running locally. Press Ctrl+C to stop it.');
    } catch (error) {
        console.error(error.message || 'Failed to start the local Telegram bot.');
        process.exitCode = 1;
    }
};

if (process.argv[2] === 'local') {
    runTelegramBot();
} else if (process.argv[2] === 'web') {
    console.error('The web dashboard is not included in this branch. Use the main branch for the web version.');
    process.exitCode = 1;
} else {
    runMainMenu();
}