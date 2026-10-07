// file: core/engine.js
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');

const { state } = require('./state');
const { runScanner } = require('./scanner');

const loggerPino = pino({ level: 'silent' });
const askQuestion = (rl) => (question) => new Promise(resolve => rl.question(question, resolve));

const safeLoadJson = (filePath) => {
    if (fs.existsSync(filePath)) {
        try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } 
        catch (e) {
            console.log('\n[!] error reading json at ' + filePath + ':\n' + e.stack);
            return []; 
        }
    }
    return [];
};

const resetState = (isResume = false, cleanName = '') => {
    if (!isResume) {
        state.targetBusiness = [];
        state.targetPersonal = [];
        state.targetUnregistered = [];
        state.statistics = { registered: 0, unregistered: 0, bioBusiness: 0, noBioBusiness: 0, personal: 0 }; 
        state.batchIndex = 0;
    } else {
        state.targetBusiness = safeLoadJson(`target_business_${cleanName}.json`);
        state.targetPersonal = safeLoadJson(`target_personal_${cleanName}.json`);
        state.targetUnregistered = safeLoadJson(`target_unregistered_${cleanName}.json`);
        
        // Recalculate statistics strictly without depending on empty strings.
        state.statistics = {
            registered: state.targetBusiness.length + state.targetPersonal.length,
            unregistered: state.targetUnregistered.length,
            bioBusiness: state.targetBusiness.filter(b => b.bio).length,
            noBioBusiness: state.targetBusiness.filter(b => !b.bio).length,
            personal: state.targetPersonal.length
        };
    }
    state.batches = [];
};

const startEngine = async (returnToMenu, webOptions = null) => {
    const interactive = !webOptions;
    const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
    const prompt = rl ? askQuestion(rl) : null;
    const closePrompt = () => rl?.close();

    try {
        if (interactive) {
            console.clear();
            console.log('=== starting scanner ===');
        }

        const txtFileList = fs.readdirSync('.').filter(f => f.endsWith('.txt') && !f.includes('report_'));
        if (interactive) console.log('\n[ target file list ]');
        
        if (txtFileList.length === 0) {
            if (interactive) {
                console.log(' - no target files found.');
                console.log('returning to menu in 2 seconds...');
                closePrompt();
                return setTimeout(returnToMenu, 2000);
            }
            throw new Error('No target files found.');
        }

        if (interactive) {
            txtFileList.forEach((f, i) => console.log(`${i + 1}. ${f}`));
            console.log('0. cancel and return');
        }
        
        let targetFile = webOptions?.targetFile;
        if (interactive) {
            const fileInput = await prompt(`\nselect target file number [0-${txtFileList.length}]: `);
            const fileIndex = parseInt(fileInput);

            if (fileInput === '0' || fileIndex === 0) {
                closePrompt();
                return returnToMenu();
            }

            if (isNaN(fileIndex) || fileIndex < 1 || fileIndex > txtFileList.length) {
                console.log('\n[!] invalid selection.');
                closePrompt();
                return setTimeout(returnToMenu, 2000);
            }
            targetFile = txtFileList[fileIndex - 1];
        }

        if (!txtFileList.includes(targetFile)) throw new Error('Selected target file was not found.');
        state.activeTargetFile = targetFile;
        const cleanName = targetFile.replace('.txt', '');

        let isResume = false;
        const checkpointFile = `checkpoint_${cleanName}.json`;
        if (fs.existsSync(checkpointFile)) {
            try {
                const tracker = JSON.parse(fs.readFileSync(checkpointFile, 'utf-8'));
                if (interactive) {
                    console.log(`\n[!] scan checkpoint found for [${targetFile}]`);
                    console.log(`    (last scan: batch ${tracker.batchIndex}/${tracker.totalBatches})`);
                    console.log('1. resume scan (continue from last point)');
                    console.log('2. delete checkpoint (start over)');
                    console.log('0. cancel');

                    const resumeChoice = await prompt('select menu [0-2]: ');
                    if (resumeChoice === '1') {
                        isResume = true;
                    } else if (resumeChoice === '2') {
                        fs.unlinkSync(checkpointFile);
                        isResume = false;
                    } else {
                        closePrompt();
                        return returnToMenu();
                    }
                } else if (webOptions.resume) {
                    isResume = true;
                } else {
                    fs.unlinkSync(checkpointFile);
                }
            } catch (e) {
                console.log('\n[!] error reading checkpoint:\n' + e.stack);
                fs.unlinkSync(checkpointFile);
            }
        }

        resetState(isResume, cleanName);
        if (isResume) {
            state.batchIndex = JSON.parse(fs.readFileSync(checkpointFile, 'utf-8')).batchIndex;
        }

        const targetData = fs.readFileSync(targetFile, 'utf-8');
        const numberList = targetData.split('\n').map(n => n.replace(/\D/g, '')).filter(n => n.length > 5);
        
        if (numberList.length === 0) {
            console.log('\n[!] target file is empty or has wrong format.');
            closePrompt();
            if (webOptions) throw new Error('Target file is empty or has the wrong format.');
            return setTimeout(returnToMenu, 2000);
        }

        if (interactive) console.log(`\ninfo: ${numberList.length} numbers ready to scan.`);
        const batchSizeInput = interactive
            ? await prompt('enter amount of numbers per batch (e.g., 50, type 0 to cancel): ')
            : String(webOptions.batchSize);

        if (interactive && batchSizeInput === '0') {
            closePrompt();
            return returnToMenu();
        }
        
        const batchLimit = parseInt(batchSizeInput) || 50;
        if (!Number.isSafeInteger(batchLimit) || batchLimit < 1) {
            throw new Error('Batch size must be a positive safe integer.');
        }
        for (let i = 0; i < numberList.length; i += batchLimit) {
            state.batches.push(numberList.slice(i, i + batchLimit));
        }

        const sessionList = fs.readdirSync('.').filter(f => f.startsWith('session_'));
        if (interactive) console.log('\n[ active sender list ]');
        
        if (sessionList.length === 0) {
            if (interactive) {
                console.log(' - no active sender. return and add one first!');
                console.log('returning to menu in 2 seconds...');
                closePrompt();
                return setTimeout(returnToMenu, 2000);
            }
            throw new Error('No sender sessions found.');
        }

        let sessionFolder = webOptions?.sessionFolder;
        if (interactive) {
            sessionList.forEach((f, i) => console.log(`${i + 1}. ${f.replace('_', ' ')}`));
            console.log('0. cancel and return');

            const sessionInput = await prompt(`\nselect sender number [0-${sessionList.length}]: `);
            const sessionIndex = parseInt(sessionInput);

            if (sessionInput === '0' || sessionIndex === 0) {
                closePrompt();
                return returnToMenu();
            }

            if (isNaN(sessionIndex) || sessionIndex < 1 || sessionIndex > sessionList.length) {
                console.log('\n[!] invalid selection.');
                closePrompt();
                return setTimeout(returnToMenu, 2000);
            }
            sessionFolder = sessionList[sessionIndex - 1];
        }

        if (!sessionList.includes(sessionFolder)) throw new Error('Selected sender session was not found.');

        if (interactive) console.log(`\nconnecting sender [${sessionFolder}]...`);
        closePrompt();

        const { state: authState, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            logger: loggerPino,
            printQRInTerminal: false,
            auth: authState,
            browser: ['My Product', 'Chrome', '10.0'],
            companionPlatformDisplay: 'Chrome (Windows)'
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                console.log(`\n[+] sender connected. initiating scanner!`);
                state.isEngineRunning = true;
                try {
                    await runScanner(sock, { exitOnError: interactive });
                    state.isEngineRunning = false;
                    webOptions?.onComplete?.();
                } catch (e) {
                    state.isEngineRunning = false;
                    console.log('fatal error while calling scanner:\n' + e.stack);
                    webOptions?.onError?.(e);
                } finally {
                    if (webOptions) {
                        sock.ws.close();
                        sock.ev.removeAllListeners();
                    }
                }
            } else if (connection === 'close') {
                console.log('\n[!] connection closed. check network or sender status.');
                if (webOptions) {
                    state.isEngineRunning = false;
                    webOptions.onError?.(new Error('Sender connection closed.'));
                } else {
                    process.exit(1);
                }
            }
        });

        if (webOptions) {
            await new Promise((resolve, reject) => {
                webOptions.onComplete = resolve;
                webOptions.onError = reject;
            });
        }
    } catch (e) {
        console.log('\nfatal error in engine bridge:\n' + e.stack);
        closePrompt();
        if (webOptions) throw e;
        if (returnToMenu) setTimeout(returnToMenu, 3000);
    }
};

module.exports = { startEngine };