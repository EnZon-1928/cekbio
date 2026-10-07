// file: core/sender.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');

const loggerPino = pino({ level: 'silent' });
const askQuestion = (rl) => (question) => new Promise(resolve => rl.question(question, resolve));

const writeLog = (message) => {
    try {
        const timestamp = new Date().toLocaleString('id-ID');
        fs.appendFileSync('log.txt', `[${timestamp}] ${message}\n`);
    } catch (e) {
        console.log('\n[!] failed to write log:\n' + e.stack);
    }
};

const getHighestSessionId = () => {
    try {
        const existingFolders = fs.readdirSync('.').filter(f => f.startsWith('session_'));
        if (existingFolders.length === 0) return 1;
        const sessionNumbers = existingFolders.map(f => parseInt(f.replace('session_', ''))).filter(n => !isNaN(n));
        return Math.max(...sessionNumbers) + 1;
    } catch (e) {
        writeLog('error finding session: ' + e.stack);
        return 1;
    }
};

const addSender = async (options = {}) => {
    const interactive = options.phoneNumber === undefined;
    const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
    const prompt = rl ? askQuestion(rl) : null;
    const closePrompt = () => rl?.close();
    
    try {
        const newId = getHighestSessionId();
        const newFolder = `session_${newId}`;
        console.log(`\npreparing new sender in [${newFolder}]...`);
        
        const { state, saveCreds } = await useMultiFileAuthState(newFolder);
        
        const phoneNumber = interactive ? await prompt('enter sender number (e.g., 628xxx): ') : options.phoneNumber;
        const cleanNumber = phoneNumber.replace(/\D/g, '');
        if (!interactive && cleanNumber.length < 6) throw new Error('Sender number is invalid.');
        closePrompt();
        
        let isPairing = false; 

        const connectEngine = async () => {
            const { version } = await fetchLatestBaileysVersion();
            
            const sock = makeWASocket({
                version,
                logger: loggerPino,
                printQRInTerminal: false,
                auth: state,
                browser: ['My Product', 'Chrome', '10.0'],
                companionPlatformDisplay: 'Chrome (Windows)'
            });

            sock.ev.on('creds.update', saveCreds);

            if (!sock.authState.creds.me?.id && !isPairing) {
                try {
                    console.log('requesting pairing code... (3 second delay)');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    
                    const code = await sock.requestPairingCode(cleanNumber);
                    isPairing = true;
                    console.log(`\n[+] pairing code: ${code}`);
                    console.log('waiting for sender response... (max 3 minutes)');
                    options.onPairingCode?.(code, newFolder);
                } catch (errPairing) {
                    writeLog(`failed to request pairing for ${cleanNumber}: ` + errPairing.stack);
                    console.log('\n[!] failed to request pairing code. check connection or log.txt');
                    sock.ws.close();
                    sock.ev.removeAllListeners();
                    if (!interactive) throw errPairing;
                    return;
                }
            }

            return new Promise((resolve) => {
                let timeoutLimit = setTimeout(() => {
                    writeLog(`[${newFolder}] timeout. sender unresponsive for 180 seconds.`);
                    console.log('\n[!] timeout. sender failed to connect (180s).');
                    sock.ws.close();
                    sock.ev.removeAllListeners();
                    resolve({ folder: newFolder, status: 'timeout' });
                }, 180000);

                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect } = update;
                    
                    if (connection === 'open') {
                        clearTimeout(timeoutLimit);
                        console.log(`\n[+] sender connected! session ${newFolder} saved.`);
                        sock.ws.close();
                        sock.ev.removeAllListeners();
                        resolve({ folder: newFolder, status: 'connected' });
                    } else if (connection === 'close') {
                        const reasonCode = lastDisconnect?.error?.output?.statusCode;
                        const errorMessage = lastDisconnect?.error?.message;
                        
                        writeLog(`[${newFolder}] connection closed. status code: ${reasonCode} | message: ${errorMessage}`);
                        
                        if (reasonCode === DisconnectReason.loggedOut || reasonCode === 403 || reasonCode === 401) {
                            console.log(`\n[!] failed. device logged out or banned (code: ${reasonCode}).`);
                            clearTimeout(timeoutLimit);
                            sock.ws.close();
                            sock.ev.removeAllListeners();
                            resolve({ folder: newFolder, status: 'failed' });
                        } else {
                            writeLog(`[${newFolder}] micro-disconnect (${reasonCode}). executing automatic reconnect...`);
                            
                            clearTimeout(timeoutLimit);
                            sock.ws.close();
                            sock.ev.removeAllListeners();
                            
                            resolve(await connectEngine());
                        }
                    }
                });
            });
        };

        return await connectEngine();

    } catch (e) {
        writeLog('fatal error adding sender: ' + e.stack);
        console.log('\nfatal error adding sender, check log.txt\n' + e.stack);
        closePrompt();
        if (!interactive) throw e;
    }
};

const pingSender = async (sessionFolder) => {
    return new Promise(async (resolve) => {
        try {
            console.log(`pinging [${sessionFolder}]...`);
            const { state } = await useMultiFileAuthState(sessionFolder);
            
            const checkConnection = async () => {
                const { version } = await fetchLatestBaileysVersion();
                const sock = makeWASocket({
                    version,
                    logger: loggerPino,
                    printQRInTerminal: false,
                    auth: state,
                    browser: ['My Product', 'Chrome', '10.0'],
                    companionPlatformDisplay: 'Chrome (Windows)'
                });

                return new Promise((res) => {
                    let timeoutLimit = setTimeout(() => {
                        writeLog(`ping timeout for ${sessionFolder}`);
                        sock.ws.close();
                        sock.ev.removeAllListeners();
                        res({ folder: sessionFolder, status: 'timeout/dead' });
                    }, 15000);

                    sock.ev.on('connection.update', async (update) => {
                        const { connection, lastDisconnect } = update;
                        if (connection === 'open') {
                            clearTimeout(timeoutLimit);
                            sock.ws.close();
                            sock.ev.removeAllListeners();
                            res({ folder: sessionFolder, status: 'alive' });
                        } else if (connection === 'close') {
                            const reasonCode = lastDisconnect?.error?.output?.statusCode;
                            if (reasonCode === DisconnectReason.loggedOut || reasonCode === 401 || reasonCode === 403) {
                                writeLog(`ping banned/logout for ${sessionFolder}. status code: ${reasonCode}`);
                                clearTimeout(timeoutLimit);
                                sock.ws.close();
                                sock.ev.removeAllListeners();
                                res({ folder: sessionFolder, status: 'banned/logged_out' });
                            } else {
                                clearTimeout(timeoutLimit);
                                sock.ws.close();
                                sock.ev.removeAllListeners();
                                res(await checkConnection());
                            }
                        }
                    });
                });
            };
            
            let globalTimeout;
            const finalResult = await Promise.race([
                checkConnection(),
                new Promise(r => {
                    globalTimeout = setTimeout(() => {
                        r({ folder: sessionFolder, status: 'timeout/dead' });
                    }, 30000);
                })
            ]);
            clearTimeout(globalTimeout);
            resolve(finalResult);
            
        } catch (e) {
            writeLog(`ping error for ${sessionFolder}: ` + e.stack);
            resolve({ folder: sessionFolder, status: 'error' });
        }
    });
};

const manageSenderSession = async (mode, data) => {
    try {
        if (mode === 'all') {
            const sessionFolders = data;
            if (sessionFolders.length === 0) return console.log('no senders found.');
            for (let folder of sessionFolders) {
                const result = await pingSender(folder);
                console.log(`  -> status: ${result.status}`);
            }
        } else if (mode === 'specific') {
            const targetFolder = `session_${data}`;
            if (fs.existsSync(targetFolder)) {
                const result = await pingSender(targetFolder);
                console.log(`  -> status: ${result.status}`);
            } else {
                console.log(`[!] directory ${targetFolder} not found.`);
            }
        } else if (mode === 'clean') {
            const sessionFolders = data;
            console.log('\ninitiating dead sender cleanup...');
            for (let folder of sessionFolders) {
                const result = await pingSender(folder);
                if (result.status === 'banned/logged_out' || result.status === 'timeout/dead') {
                    fs.rmSync(folder, { recursive: true, force: true });
                    console.log(`[+] ${folder} deleted.`);
                } else {
                    console.log(`[-] ${folder} is alive, preserved.`);
                }
            }
            console.log('cleanup complete.');
        }
    } catch (e) {
        writeLog('error managing sender: ' + e.stack);
    }
};

module.exports = { addSender, manageSenderSession, pingSender };