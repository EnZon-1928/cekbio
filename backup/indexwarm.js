const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const { execSync } = require('child_process');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');

const nomorUtama = "6283862503428";

const logAsli = console.log;
const errorAsli = console.error;
const saringLog = (...args) => {
    const teks = args.join(' ').toLowerCase();
    const sampah = ['_chains', 'sessionentry', 'prekey bundle', 'closing open session', 'closing session'];
    return !sampah.some(s => teks.includes(s));
};
console.log = function(...args) {
    if (saringLog(...args)) logAsli.apply(console, args);
};
console.error = function(...args) {
    if (saringLog(...args)) errorAsli.apply(console, args);
};

const logMinimal = (konteks, pesan) => {
    const waktu = new Date().toLocaleTimeString('id-ID', { hour12: false });
    console.log(`[${waktu}] ${konteks}: ${pesan}`);
};

try {
    logMinimal('sistem', 'mengunci cpu termux');
    execSync('termux-wake-lock');
} catch (e) {
    logMinimal('error', e.stack);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const tanyaTerminal = (pertanyaan) => new Promise(resolve => rl.question(pertanyaan, resolve));

let listBot = [];
let sedangRotasi = false;
let waktuMulai = Date.now();
const targetPemanasan = 10 * 60 * 1000; 

const daftarBrowser = [["Ubuntu", "Chrome", "20.0.04"], ["Windows", "Chrome", "119.0.6045.105"], ["Mac OS", "Safari", "16.1"], ["Windows", "Edge", "119.0.2151.44"], ["Mac OS", "Chrome", "119.0.6045.105"]];

const jedaWaktu = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

const injeksiNoiseWaWeb = async (sock, namaBot) => {
    try {
        const noiseType = Math.random();
        if (noiseType < 0.33) {
            await sock.fetchBlocklist();
            logMinimal(namaBot, 'mengirim noise (cek blocklist)');
        } else if (noiseType < 0.66) {
            await sock.fetchPrivacySettings();
            logMinimal(namaBot, 'mengirim noise (cek privasi)');
        } else {
            await sock.groupFetchAllParticipating().catch(() => null);
            logMinimal(namaBot, 'mengirim noise (cek metadata grup)');
        }
    } catch (e) {
        logMinimal('error_noise', e.stack);
    }
};

function mulaiBot(dataBot) {
    return new Promise((resolve) => {
        const jalankanSocket = async () => {
            const namaFolderSesi = `sesi_${dataBot.nomor}`;
            const msgRetryCounterCache = new NodeCache();
            let timerPairing = null;
            
            try {
                const { state, saveCreds } = await useMultiFileAuthState(namaFolderSesi);
                const { version } = await fetchLatestBaileysVersion();
                const browserPilihan = daftarBrowser[Math.floor(Math.random() * daftarBrowser.length)];
                const loggerSilent = pino({ level: 'silent' });
                
                const signalKeys = typeof makeCacheableSignalKeyStore === 'function' ? makeCacheableSignalKeyStore(state.keys, loggerSilent) : state.keys;
                
                const sock = makeWASocket({ 
                    version, 
                    auth: {
                        creds: state.creds,
                        keys: signalKeys,
                    },
                    msgRetryCounterCache,
                    printQRInTerminal: false, 
                    logger: loggerSilent, 
                    browser: browserPilihan, 
                    keepAliveIntervalMs: 30000,
                    syncFullHistory: false,
                    markOnlineOnConnect: false,
                    generateHighQualityLinkPreviews: false
                });

                if (!sock.authState.creds.registered) {
                    logMinimal('auth', `bot ${dataBot.nama} butuh pairing`);
                    timerPairing = setTimeout(async () => {
                        try {
                            const kode = await sock.requestPairingCode(dataBot.nomor);
                            console.log(`[kode pairing ${dataBot.nama}]: ${kode}`);
                        } catch (e) {
                            logMinimal('error', e.stack);
                        }
                    }, 4000);
                }

                sock.ev.on('creds.update', saveCreds);
                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect } = update;
                    if (connection === 'close') {
                        dataBot.isReady = false;
                        if (timerPairing) clearTimeout(timerPairing);
                        const alasan = lastDisconnect?.error?.output?.statusCode;
                        if (alasan !== DisconnectReason.loggedOut && !sedangRotasi) {
                            setTimeout(() => jalankanSocket(), 5000);
                        } else {
                            resolve(null); 
                        }
                    } else if (connection === 'open') {
                        logMinimal(dataBot.nama, 'siap pemanasan');
                        dataBot.sock = sock;
                        dataBot.isReady = true;
                        resolve(sock);
                    }
                });

                sock.ev.on('messages.upsert', async ({ messages, type }) => {
                    if (type !== 'notify' || !dataBot.isReady) return;
                    for (const msg of messages) {
                        const jid = msg.key.remoteJid;
                        if (jid === 'status@broadcast' && msg.key.participant?.includes(nomorUtama)) {
                            logMinimal(dataBot.nama, `mendeteksi story dari ${nomorUtama}`);
                            await jedaWaktu(5000, 15000);
                            await sock.readMessages([msg.key]);
                            logMinimal(dataBot.nama, 'berhasil melihat story');
                        }
                    }
                });

            } catch (e) {
                logMinimal('error_fatal', e.stack);
                resolve(null);
            }
        };
        jalankanSocket();
    });
}

async function simulasiAksi(bot) {
    while (Date.now() - waktuMulai < targetPemanasan) {
        try {
            if (!bot || !bot.isReady) {
                await jedaWaktu(5000, 5000);
                continue;
            }

            const aksi = Math.random();
            const jidUtama = nomorUtama + "@s.whatsapp.net";

            if (aksi < 0.25) {
                logMinimal(bot.nama, 'mode available');
                await bot.sock.sendPresenceUpdate('available');
                await jedaWaktu(20000, 40000);
                await injeksiNoiseWaWeb(bot.sock, bot.nama);
            } else if (aksi < 0.5) {
                logMinimal(bot.nama, 'simulasi stalking profile');
                await bot.sock.onWhatsApp(nomorUtama);
                await bot.sock.profilePictureUrl(jidUtama, 'image').catch(() => null);
                await bot.sock.fetchStatus(jidUtama).catch(() => null);
                await jedaWaktu(15000, 30000);
            } else if (aksi < 0.75) {
                logMinimal(bot.nama, 'simulasi mengetik pasif');
                await bot.sock.sendPresenceUpdate('composing', jidUtama);
                await jedaWaktu(5000, 12000);
                await bot.sock.sendPresenceUpdate('paused', jidUtama);
                await jedaWaktu(10000, 20000);
            } else {
                await injeksiNoiseWaWeb(bot.sock, bot.nama);
                await jedaWaktu(15000, 25000);
            }

            await bot.sock.sendPresenceUpdate('unavailable');
            await jedaWaktu(20000, 45000);

        } catch (e) {
            logMinimal('error', e.stack);
        }
    }
}

async function mulaiPemanasan() {
    try {
        console.log("masukkan data bot warmup (ketik 'gas'):");
        let counter = 1;
        while(true) {
            const inputTeks = await tanyaTerminal(`wa ${counter}: `);
            if (inputTeks.toLowerCase().trim() === 'gas') break;
            const no = inputTeks.replace(/[^0-9]/g, '');
            if (no !== "") {
                const nm = await tanyaTerminal(`nama ${counter}: `);
                listBot.push({ nomor: no, nama: nm, isReady: false });
                counter++;
            }
        }
        rl.close();

        logMinimal('sistem', 'memulai antrean login staggered');
        for (let bot of listBot) {
            await mulaiBot(bot);
            await jedaWaktu(8000, 15000);
        }

        logMinimal('sistem', `sinkronisasi selesai, memulai pemanasan 10 menit`);
        waktuMulai = Date.now();
        
        const antreanAksi = listBot.map(bot => simulasiAksi(bot));
        await Promise.all(antreanAksi);

        logMinimal('sistem', 'durasi target tercapai, membersihkan sesi dengan aman');
        for (let bot of listBot) {
            if (bot.sock) {
                await bot.sock.sendPresenceUpdate('unavailable');
                await jedaWaktu(1000, 2000);
                bot.sock.ws.close();
            }
        }
        process.exit(0);

    } catch (e) {
        logMinimal('error_main', e.stack);
    }
}

mulaiPemanasan();
