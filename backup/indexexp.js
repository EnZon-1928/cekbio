const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const { execSync } = require('child_process');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const memStore = {};
const filePasukan = './pasukan_bot.json';
const consoleAsli = console.log;
console.log = function (...args) {
    if (args.length > 0 && typeof args[0] === 'string') {
        const teks = args[0].toLowerCase();
        if (teks.includes('closing open session') || teks.includes('closing session:')) {
            return; 
        }
    }
    consoleAsli.apply(console, args);
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
let sedangShutdown = false;
let sedangRotasi = false;
let duelAktif = { pusat: null, target: null, status: 'idle', langkah: 0, selesai: false, pemegangTongkat: null };
const daftarBrowser = [["Ubuntu", "Chrome", "20.0.04"], ["Windows", "Chrome", "119.0.6045.105"], ["Mac OS", "Safari", "16.1"], ["Windows", "Edge", "119.0.2151.44"], ["Mac OS", "Chrome", "119.0.6045.105"]];

const jedaWaktu = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

const spintax = (teks) => {
    const regex = /\{([^{}]+)\}/g;
    return teks.replace(regex, (match, p1) => {
        const pilihan = p1.split('|');
        return pilihan[Math.floor(Math.random() * pilihan.length)];
    });
};

const keyboardBerdampingan = {
    'q': ['w', 'a'], 'w': ['q', 'e', 's', 'a'], 'e': ['w', 'r', 'd', 's'], 'r': ['e', 't', 'f', 'd'], 't': ['r', 'y', 'g', 'f'], 'y': ['t', 'u', 'h', 'g'], 'u': ['y', 'i', 'j', 'h'], 'i': ['u', 'o', 'k', 'j'], 'o': ['i', 'p', 'l', 'k'], 'p': ['o', 'l'],
    'a': ['q', 'w', 's', 'z'], 's': ['w', 'e', 'a', 'd', 'z', 'x'], 'd': ['e', 'r', 's', 'f', 'x', 'c'], 'f': ['r', 't', 'd', 'g', 'c', 'v'], 'g': ['t', 'y', 'f', 'h', 'v', 'b'], 'h': ['y', 'u', 'g', 'j', 'b', 'n'], 'j': ['u', 'i', 'h', 'k', 'n', 'm'], 'k': ['i', 'o', 'j', 'l', 'm'], 'l': ['o', 'p', 'k'],
    'z': ['a', 's', 'x'], 'x': ['s', 'd', 'z', 'c'], 'c': ['d', 'f', 'x', 'v'], 'v': ['f', 'g', 'c', 'b'], 'b': ['g', 'h', 'v', 'n'], 'n': ['h', 'j', 'b', 'm'], 'm': ['j', 'k', 'n']
};

const buatTypo = (teks, rasio = 0.03) => {
    let hasil = "";
    for (let i = 0; i < teks.length; i++) {
        let char = teks[i];
        let isUpper = char >= 'A' && char <= 'Z';
        let lowerChar = char.toLowerCase();
        if (keyboardBerdampingan[lowerChar] && Math.random() < rasio) {
            let pilihanTypo = keyboardBerdampingan[lowerChar];
            let typoChar = pilihanTypo[Math.floor(Math.random() * pilihanTypo.length)];
            hasil += isUpper ? typoChar.toUpperCase() : typoChar;
        } else {
            hasil += char;
        }
    }
    return hasil;
};

const injeksiNoise = (teks) => teks + " ".repeat(Math.floor(Math.random() * 3));

const prosesTeksStealth = (teksMentah) => injeksiNoise(buatTypo(spintax(teksMentah), 0.03));

const muatPasukan = () => {
    try {
        if (fs.existsSync(filePasukan)) {
            const isi = fs.readFileSync(filePasukan, 'utf8');
            const data = JSON.parse(isi);
            return data.map(b => ({ nomor: b.nomor, nama: b.nama, browser: b.browser, isReady: false, isBanned: false, sedangMengetik: false }));
        }
    } catch (e) {
        logMinimal('error', e.stack);
    }
    return [];
};

const simpanPasukan = (pasukan) => {
    try {
        const dataBersih = pasukan.map(b => ({ nomor: b.nomor, nama: b.nama, browser: b.browser }));
        fs.writeFileSync(filePasukan, JSON.stringify(dataBersih, null, 2));
    } catch (e) {
        logMinimal('error', e.stack);
    }
};

function buatJadwalSilang(totalBot, siklusKe = 1) {
    let jadwal = [];
    let indices = Array.from({length: totalBot}, (_, i) => i);
    if (totalBot % 2 !== 0) indices.push(-1);
    const totalRonde = indices.length - 1;
    const setengah = indices.length / 2;
    const isGanjil = siklusKe % 2 !== 0; 
    for (let r = 0; r < totalRonde; r++) {
        let gelombang = [];
        for (let i = 0; i < setengah; i++) {
            let p1 = indices[i];
            let p2 = indices[indices.length - 1 - i];
            if (p1 !== -1 && p2 !== -1) {
                const min = Math.min(p1, p2);
                const max = Math.max(p1, p2);
                if (isGanjil) {
                    gelombang.push({ pusat: min, target: max });
                } else {
                    gelombang.push({ pusat: max, target: min });
                }
            }
        }
        jadwal.push(gelombang);
        indices.splice(1, 0, indices.pop());
    }
    return jadwal.reverse();
}

const fungsiRotasiIP = async () => {
    sedangRotasi = true;
    logMinimal('sistem', 'memberikan jeda sinkronisasi sebelum rotasi ip');
    await jedaWaktu(8000, 15000);
    logMinimal('sistem', 'menjalankan rotasi ip');
    try {
        execSync("su -c 'settings put global airplane_mode_on 1 && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true'");
        await jedaWaktu(10000, 12000);
        execSync("su -c 'settings put global airplane_mode_on 0 && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false'");
        let internetReady = false;
        while (!internetReady) {
            try {
                execSync("ping -c 1 -W 2 8.8.8.8", { stdio: 'ignore' });
                internetReady = true;
            } catch (e) {
                await jedaWaktu(3000, 3000);
            }
        }
        // JEDA KRUSIAL: Sinkronisasi jam sistem ke jaringan (NTP)
        logMinimal('sistem', 'internet ready, menstabilkan jam sistem...');
        await jedaWaktu(5000, 8000); 
        logMinimal('sistem', 'rotasi ip berhasil');
    } catch (e) {
        logMinimal('error', e.stack);
    }
    sedangRotasi = false;
};

function mulaiBot(dataBot) {
    return new Promise((resolve) => {
        const jalankanSocket = async () => {
            if (sedangShutdown || dataBot.isBanned) return;
            const namaFolderSesi = `sesi_${dataBot.nomor}`;
            let timerPairing = null;
            const msgRetryCounterCache = new NodeCache();
            try {
                const { state, saveCreds } = await useMultiFileAuthState(namaFolderSesi);
                const { version } = await fetchLatestBaileysVersion();
                const loggerSilent = pino({ level: 'silent' });
                if (!memStore[dataBot.nomor]) {
                    memStore[dataBot.nomor] = { messages: new Map() };
                }
                const sock = makeWASocket({ 
                    version, 
                    auth: {
                        creds: state.creds,
                        keys: makeCacheableSignalKeyStore(state.keys, loggerSilent),
                    },
                    msgRetryCounterCache,
                    printQRInTerminal: false, 
                    logger: loggerSilent, 
                    browser: dataBot.browser, 
                    keepAliveIntervalMs: 30000,
                    getMessage: async (key) => {
                        const botStore = memStore[dataBot.nomor];
                        if (botStore && botStore.messages.has(key.id)) {
                            return botStore.messages.get(key.id);
                        }
                        // dilarang keras return fake message. kembalikan undefined.
                        return undefined;
                    }
                });
                if (!sock.authState.creds.registered) {
                    logMinimal('auth', `bot ${dataBot.nama} butuh pairing`);
                    timerPairing = setTimeout(async () => {
                        if (sedangShutdown || sedangRotasi) return;
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
                        const alasan = lastDisconnect?.error?.output?.statusCode;
                        if (alasan === 403) {
                            logMinimal('fatal', `bot ${dataBot.nama} tewas/banned`);
                            dataBot.isBanned = true;
                            try {
                                fs.rmSync(namaFolderSesi, { recursive: true, force: true });
                                listBot = listBot.filter(b => b.nomor !== dataBot.nomor);
                                simpanPasukan(listBot);
                            } catch (e) {
                                logMinimal('error', e.stack);
                            }
                            resolve(null);
                        } else if (alasan === DisconnectReason.loggedOut || alasan === 401) {
                            logMinimal('sistem', `sesi ${dataBot.nama} terputus manual, siap pairing ulang`);
                            try {
                                fs.rmSync(namaFolderSesi, { recursive: true, force: true });
                            } catch (e) {
                                logMinimal('error', e.stack);
                            }
                            jalankanSocket();
                        } else if (alasan === 515) {
                            try { 
                                sock.ev.removeAllListeners(); 
                                sock.ws.close(); 
                            } catch (e) { 
                                logMinimal('error', e.stack); 
                            }
                            jalankanSocket();
                        } else {
                            try { 
                                sock.ev.removeAllListeners(); 
                                sock.ws.close(); 
                            } catch (e) { 
                                logMinimal('error', e.stack); 
                            }
                            setTimeout(() => jalankanSocket(), 5000);
                        }
                    } else if (connection === 'open') {
                        logMinimal('koneksi', `${dataBot.nama} terhubung`);
                        dataBot.sock = sock;
                        logMinimal('sistem', `mengamankan sinkronisasi ${dataBot.nama}...`);
                        await jedaWaktu(15000, 20000);
                        dataBot.isReady = true;
                        resolve(sock);
                    }
                });
                sock.ev.on('messages.upsert', async ({ messages, type }) => {
                    if (dataBot.isBanned || sedangShutdown || sedangRotasi) return;
                    if (type !== 'notify') return;
                    for (const msg of messages) {
                        if (msg.message && msg.key.id) {
                            const botStore = memStore[dataBot.nomor];
                            botStore.messages.set(msg.key.id, msg.message);
                            if (botStore.messages.size > 500) {
                                const kunciPertama = botStore.messages.keys().next().value;
                                botStore.messages.delete(kunciPertama);
                            }
                        }
                        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) continue;
                        const jid = msg.key.remoteJid;
                        const pengirim = jid.split('@')[0];
                        const botPusat = duelAktif.pusat !== null ? listBot[duelAktif.pusat] : null;
                        const botTarget = duelAktif.target !== null ? listBot[duelAktif.target] : null;
                        const isPusatMenerima = botPusat && botTarget && dataBot.nomor === botPusat.nomor && pengirim === botTarget.nomor;
                        const isTargetMenerima = botPusat && botTarget && dataBot.nomor === botTarget.nomor && pengirim === botPusat.nomor;
                        if (duelAktif.status === 'berjalan' && ((isPusatMenerima && duelAktif.pemegangTongkat === 'pusat') || (isTargetMenerima && duelAktif.pemegangTongkat === 'target'))) {
                            if (dataBot.sedangMengetik) continue;
                            try {
                                const teksDiterima = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
                                const kirimDinamis = async (teksKirim, setStatusLokal) => {
                                    if (dataBot.isBanned) return;
                                    dataBot.sedangMengetik = true;
                                    const durasiBaca = Math.max(1000, Math.floor((teksDiterima.length / 15) * 1000));
                                    await jedaWaktu(durasiBaca, durasiBaca + 1000);
                                    await sock.sendPresenceUpdate('available', jid);
                                    await jedaWaktu(1500, 3000);
                                    const durasiTotal = Math.max(2000, Math.floor((teksKirim.length / 5) * 1000));
                                    const perluPause = teksKirim.length > 20 && Math.random() > 0.3;
                                    if (perluPause) {
                                        const proporsi = Math.random() * (0.6 - 0.4) + 0.4;
                                        const durasiAwal = Math.floor(durasiTotal * proporsi);
                                        const durasiSisa = durasiTotal - durasiAwal;
                                        await sock.sendPresenceUpdate('composing', jid);
                                        await jedaWaktu(durasiAwal, durasiAwal + 800);
                                        await sock.sendPresenceUpdate('paused', jid);
                                        await jedaWaktu(1000, 2000);
                                        await sock.sendPresenceUpdate('composing', jid);
                                        await jedaWaktu(durasiSisa, durasiSisa + 800);
                                    } else {
                                        await sock.sendPresenceUpdate('composing', jid);
                                        await jedaWaktu(durasiTotal, durasiTotal + 800);
                                    }
                                    await sock.sendPresenceUpdate('paused', jid);
                                    if (typeof setStatusLokal === 'function') {
                                        setStatusLokal();
                                    }
                                    await sock.sendMessage(jid, { text: teksKirim });
                                    await jedaWaktu(2000, 4000);
                                    await sock.sendPresenceUpdate('unavailable', jid);
                                    dataBot.sedangMengetik = false;
                                };
                                if (isPusatMenerima) {
                                    if (duelAktif.langkah === 1) {
                                        logMinimal(botPusat.nama, `mengirim langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{sama-sama|yep|oke} kak. aku {asli|dari} karawang, kakak {posisinya|domisilinya|tinggalnya} di mana {nih|yak}?"), () => { duelAktif.langkah = 2; duelAktif.pemegangTongkat = 'target'; });
                                    } else if (duelAktif.langkah === 3) {
                                        logMinimal(botPusat.nama, `mengirim langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{ohh|owh|oh} {gituuu|gitu}, {mantap|oke} deh. {btw|ngomong-ngomong} {umur|usia} berapa nih kak {sekarang|skrg}?"), () => { duelAktif.langkah = 4; duelAktif.pemegangTongkat = 'target'; });
                                    } else if (duelAktif.langkah === 5) {
                                        logMinimal(botPusat.nama, `mengirim langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("aku {26|26 tahun} kak. {sibuk|lagi sibuk} apa nih {sehari-harinya|tiap harinya}?"), () => { duelAktif.langkah = 6; duelAktif.pemegangTongkat = 'target'; });
                                    } else if (duelAktif.langkah === 7) {
                                        logMinimal(botPusat.nama, `mengirim langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("oh {pantesan|pantas} agak {sibuk|repot} ya. {hobi|kesukaan} apa kak {kalau|kalo} lagi {libur|senggang}?"), () => { duelAktif.langkah = 8; duelAktif.pemegangTongkat = 'target'; });
                                    } else if (duelAktif.langkah === 9) {
                                        logMinimal(botPusat.nama, `mengirim langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{wah|wih} sama {dong|tuh}! {game apa|main apa} emang kak?"), () => { duelAktif.langkah = 10; duelAktif.pemegangTongkat = 'target'; });
                                    } else if (duelAktif.langkah === 11) {
                                        logMinimal(botPusat.nama, `mengirim langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{wih|wah} mantap, {kapan-kapan|kapan2} mabar lah. {btw|oh ya} cuaca di sana panas gak?"), () => { duelAktif.langkah = 12; duelAktif.pemegangTongkat = 'target'; });
                                    } else if (duelAktif.langkah === 13) {
                                        logMinimal(botPusat.nama, `mengirim langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{disini|tempatku} lagi {mendung|hujan} nih kak. yaudah kak {lanjut dulu ya|lanjutin aja dulu} aktivitasnya, {salken|salam kenal} pokoknya! 🙏"), () => { duelAktif.langkah = 14; duelAktif.pemegangTongkat = 'target'; });
                                    } else if (duelAktif.langkah === 15) {
                                        dataBot.sedangMengetik = true;
                                        await jedaWaktu(2000, 4000);
                                        logMinimal(botPusat.nama, 'menerima pesan penutup tanpa read');
                                        duelAktif.selesai = true;
                                        duelAktif.pemegangTongkat = null;
                                        dataBot.sedangMengetik = false;
                                    }
                                } else if (isTargetMenerima) {
                                    if (duelAktif.langkah === 0) {
                                        logMinimal(botTarget.nama, `membalas langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{oke|ok|sip|yoi} kak {udah|sudah} disave ya, {salken|salam kenal}!"), () => { duelAktif.langkah = 1; duelAktif.pemegangTongkat = 'pusat'; });
                                    } else if (duelAktif.langkah === 2) {
                                        logMinimal(botTarget.nama, `membalas langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("aku {domisili|di|stay di} jakarta kak."), () => { duelAktif.langkah = 3; duelAktif.pemegangTongkat = 'pusat'; });
                                    } else if (duelAktif.langkah === 4) {
                                        logMinimal(botTarget.nama, `membalas langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("aku {24|24 thn} kak {hehe|haha|wkwk}, kakak?"), () => { duelAktif.langkah = 5; duelAktif.pemegangTongkat = 'pusat'; });
                                    } else if (duelAktif.langkah === 6) {
                                        logMinimal(botTarget.nama, `membalas langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{kerja|gawe} aja sih kak, {rutinitas|kegiatan} biasa."), () => { duelAktif.langkah = 7; duelAktif.pemegangTongkat = 'pusat'; });
                                    } else if (duelAktif.langkah === 8) {
                                        logMinimal(botTarget.nama, `membalas langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{paling|palingan} rebahan aja kak {atau|atau kadang} main game {wkwk|hehe}."), () => { duelAktif.langkah = 9; duelAktif.pemegangTongkat = 'pusat'; });
                                    } else if (duelAktif.langkah === 10) {
                                        logMinimal(botTarget.nama, `membalas langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{mlbb|em el|mobile legend} kak biasanya, {seru|lumayan} buat ngisi waktu."), () => { duelAktif.langkah = 11; duelAktif.pemegangTongkat = 'pusat'; });
                                    } else if (duelAktif.langkah === 12) {
                                        logMinimal(botTarget.nama, `membalas langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{boleh|gas|ayo} kak. disini lumayan {panas|gerah} sih."), () => { duelAktif.langkah = 13; duelAktif.pemegangTongkat = 'pusat'; });
                                    } else if (duelAktif.langkah === 14) {
                                        logMinimal(botTarget.nama, `membalas langkah ${duelAktif.langkah + 1}`);
                                        await kirimDinamis(prosesTeksStealth("{oke|siap} kak {siap|oke}, sukses terus ya! ✨"), () => { duelAktif.langkah = 15; duelAktif.pemegangTongkat = 'pusat'; });
                                    }
                                }
                            } catch (e) {
                                dataBot.sedangMengetik = false;
                                logMinimal('error', e.stack);
                            }
                        } else {
                            const isDariBotSirkel = listBot.some(b => b.nomor === pengirim);
                            if (isDariBotSirkel) {
                                try {
                                    await jedaWaktu(1500, 2500);
                                    await jedaWaktu(2000, 4000);
                                } catch (e) {
                                    logMinimal('error', e.stack);
                                }
                            }
                        }
                    }
                });
            } catch (e) {
                logMinimal('error', e.stack);
                if (timerPairing) clearTimeout(timerPairing);
                if (!sedangShutdown) setTimeout(() => jalankanSocket(), 5000);
            }
        };
        jalankanSocket();
    });
}

async function mulaiSistemPerang() {
    try {
        listBot = muatPasukan();
        let lanjutInput = true;
        if (listBot.length > 0) {
            console.log(`[database] ${listBot.length} nomor pasukan ditemukan.`);
            const tanya = await tanyaTerminal(`ketik 'y' untuk tambah bot, atau 'gas' untuk langsung mulai: `);
            if (tanya.toLowerCase().trim() !== 'y') {
                lanjutInput = false;
                if (listBot.length < 2) {
                    console.log("minimal harus ada 2 bot bro. silakan mulai ulang dan tambah bot.");
                    process.exit(1);
                }
            }
        } else {
            console.log("database kosong. masukkan data bot baru:");
        }

        let counter = listBot.length + 1;
        while(lanjutInput) {
            const inputTeks = await tanyaTerminal(`wa ${counter} (ketik 'gas' jika selesai): `);
            if (inputTeks.toLowerCase().trim() === 'gas') {
                if (listBot.length < 2) {
                    console.log("minimal harus ada 2 bot bro.");
                } else {
                    lanjutInput = false;
                }
            } else {
                const no = inputTeks.replace(/[^0-9]/g, '');
                if (no !== "") {
                    const nm = await tanyaTerminal(`nama ${counter}: `);
                    const identitasBrowserAwal = daftarBrowser[Math.floor(Math.random() * daftarBrowser.length)];
                    listBot.push({ nomor: no, nama: nm, isReady: false, isBanned: false, sedangMengetik: false, browser: identitasBrowserAwal });
                    counter++;
                }
            }
        }
        
        simpanPasukan(listBot);
        rl.close();

        for (let bot of listBot) {
            await mulaiBot(bot);
        }
        
        let siklusKe = 1;
        while (!sedangShutdown) {
            logMinimal('sistem', `siklus ${siklusKe} dimulai`);
            const jadwalFull = buatJadwalSilang(listBot.length, siklusKe); 
            for (let r = 0; r < jadwalFull.length; r++) {
                if (sedangShutdown) break;
                let botHidup = listBot.filter(b => !b.isBanned).length;
                if (botHidup < 2) {
                    logMinimal('sistem', 'bot sisa < 2, shutdown');
                    sedangShutdown = true;
                    break;
                }
                const gelombang = jadwalFull[r];
                for (let pertarungan of gelombang) {
                    if (sedangShutdown) break;
                    const pusat = listBot[pertarungan.pusat];
                    const target = listBot[pertarungan.target];
                    if (pusat.isBanned || target.isBanned) continue;
                    let botSedangSibuk = true;
                    while (botSedangSibuk) {
                        botSedangSibuk = listBot.some(b => b.sedangMengetik);
                        if (botSedangSibuk) await jedaWaktu(1000, 1000);
                    }
                    await fungsiRotasiIP();
                    let batasTunggu = 0;
                    while ((!pusat.isReady || !target.isReady) && batasTunggu < 30) {
                        if (pusat.isBanned || target.isBanned) break;
                        await jedaWaktu(2000, 2000);
                        batasTunggu++;
                    }
                    if (pusat.isBanned || target.isBanned || !pusat.isReady || !target.isReady) continue;
                    await jedaWaktu(5000, 8000);
                    duelAktif = { pusat: pertarungan.pusat, target: pertarungan.target, langkah: 0, selesai: false, status: 'berjalan', pemegangTongkat: 'pusat' };
                    try {
                        logMinimal('duel', `${pusat.nama} vs ${target.nama} dimulai`);
                        const pesanMentahAwal = `{halo|hai|p|permisi} kak, {tolong|bantu} save {nomor aku|no aku|kontakku} ya, {nama aku|namaku|ini} ${pusat.nama} , {makasih|thanks|tengkyu}! 🙏`;
                        const pesanAwal = prosesTeksStealth(pesanMentahAwal);
                        const jidAwal = target.nomor + "@s.whatsapp.net";
                        const durasiTotalAwal = Math.max(2000, Math.floor((pesanAwal.length / 5) * 1000));
                        const perluPauseAwal = pesanAwal.length > 20 && Math.random() > 0.3;
                        pusat.sedangMengetik = true;
                        await pusat.sock.sendPresenceUpdate('available', jidAwal);
                        await jedaWaktu(2000, 4000);
                        if (perluPauseAwal) {
                            const proporsi = Math.random() * (0.6 - 0.4) + 0.4;
                            const durasiAwalAwal = Math.floor(durasiTotalAwal * proporsi);
                            const durasiSisaAwal = durasiTotalAwal - durasiAwalAwal;
                            await pusat.sock.sendPresenceUpdate('composing', jidAwal);
                            await jedaWaktu(durasiAwalAwal, durasiAwalAwal + 800);
                            await pusat.sock.sendPresenceUpdate('paused', jidAwal);
                            await jedaWaktu(1500, 3000);
                            await pusat.sock.sendPresenceUpdate('composing', jidAwal);
                            await jedaWaktu(durasiSisaAwal, durasiSisaAwal + 800);
                        } else {
                            await pusat.sock.sendPresenceUpdate('composing', jidAwal);
                            await jedaWaktu(durasiTotalAwal, durasiTotalAwal + 800);
                        }
                        await pusat.sock.sendPresenceUpdate('paused', jidAwal);
                        duelAktif.pemegangTongkat = 'target';
                        await pusat.sock.sendMessage(jidAwal, { text: pesanAwal });
                        await jedaWaktu(2000, 4000);
                        await pusat.sock.sendPresenceUpdate('unavailable', jidAwal);
                        pusat.sedangMengetik = false;
                        await new Promise(resolve => {
                            let counterAman = 0;
                            const cek = setInterval(() => {
                                counterAman++;
                                if (duelAktif.selesai || pusat.isBanned || target.isBanned) {
                                    clearInterval(cek);
                                    resolve();
                                } else if (counterAman >= 120) {
                                    logMinimal('sistem', 'waktu habis, paksa lanjut');
                                    clearInterval(cek);
                                    resolve();
                                }
                            }, 2000);
                        });
                    } catch (e) {
                        logMinimal('error', e.stack);
                    } finally {
                        pusat.sedangMengetik = false;
                        target.sedangMengetik = false;
                    }
                    logMinimal('duel', 'selesai (status: normal)');
                    duelAktif.status = 'idle';
                    const jeda = Math.floor(Math.random() * (20000 - 15000 + 1)) + 15000;
                    await jedaWaktu(jeda, jeda);
                }
            }
            siklusKe++;
        }
        logMinimal('sistem', 'berhenti, membersihkan memori');
        for (let bot of listBot) {
            if (!bot.isBanned) {
                try {
                    bot.sock.ws.close();
                } catch (e) {
                    logMinimal('error', e.stack);
                }
            }
        }
        process.exit(0);
    } catch (e) {
        logMinimal('error', e.stack);
    }
}
mulaiSistemPerang();
