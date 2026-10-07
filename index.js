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
runMainMenu();