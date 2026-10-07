const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const { execSync } = require('child_process');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const memStore = {};
const filePasukan = './pasukan_bot.json';
const consoleLogAsli = console.log;
const consoleWarnAsli = console.warn;
const consoleInfoAsli = console.info;
const consoleErrorAsli = console.error;
const saringTerminal = (...args) => {
    let teks = "";
    for (let arg of args) {
        teks += (typeof arg === 'string' ? arg : JSON.stringify(arg)) + " ";
    }
    teks = teks.toLowerCase();
    if (teks.includes('closing open session') || teks.includes('closing session') || teks.includes('prekey bundle')) {
        return false;
    }
    return true;
};
console.log = function (...args) {
    if (saringTerminal(...args)) consoleLogAsli.apply(console, args);
};
console.warn = function (...args) {
    if (saringTerminal(...args)) consoleWarnAsli.apply(console, args);
};
console.info = function (...args) {
    if (saringTerminal(...args)) consoleInfoAsli.apply(console, args);
};
console.error = function (...args) {
    if (saringTerminal(...args)) consoleErrorAsli.apply(console, args);
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
let duelAktif = { pusat: null, target: null, status: 'idle', selesai: false, pemegangTongkat: null, topikTersedia: [], topikAktif: null, jumlahTopik: 0 };
const daftarBrowser = [["Ubuntu", "Chrome", "20.0.04"], ["Windows", "Chrome", "119.0.6045.105"], ["Mac OS", "Safari", "16.1"], ["Windows", "Edge", "119.0.2151.44"], ["Mac OS", "Chrome", "119.0.6045.105"]];
const databaseObrolan = {
    sapaan: { tanya: "{halo|hai|p|permisi} kak, {tolong|bantu} save {nomor aku|no aku|kontakku} ya, {nama aku|namaku|ini} {namapusat} , {makasih|thanks|tengkyu}! 🙏", jawab: "{oke|ok|sip|yoi} kak {udah|sudah} disave ya, {salken|salam kenal}!" },
    domisili: { tanya: "aku {asli|dari} karawang, kakak {posisinya|domisilinya|tinggalnya} di mana {nih|yak}?", jawab: "aku {domisili|di|stay di} jakarta kak." },
    umur: { tanya: "{btw|ngomong-ngomong} {umur|usia} berapa nih kak {sekarang|skrg}?", jawab: "aku {24|24 thn} kak {hehe|haha|wkwk}." },
    kesibukan: { tanya: "{sibuk|lagi sibuk} apa nih {sehari-harinya|tiap harinya} kak?", jawab: "{kerja|gawe} aja sih kak, {rutinitas|kegiatan} biasa." },
    hobi: { tanya: "{hobi|kesukaan} apa kak {kalau|kalo} lagi {libur|senggang}?", jawab: "{paling|palingan} rebahan aja kak {atau|atau kadang} main game {wkwk|hehe}." },
    game: { tanya: "{wah|wih} {game apa|main apa} emang kak?", jawab: "{mlbb|em el|mobile legend} kak biasanya, {seru|lumayan} buat ngisi waktu." },
    cuaca: { tanya: "{btw|oh ya} cuaca di sana panas gak kak?", jawab: "disini lumayan {panas|gerah} sih kak." },
    pamitan: { tanya: "yaudah kak {lanjut dulu ya|lanjutin aja dulu} aktivitasnya, {salken|salam kenal} pokoknya! 🙏", jawab: "{oke|siap} kak {siap|oke}, sukses terus ya! ✨" }
};
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
const kirimDinamis = async (sockLokal, jidLokal, teksMentah, dataBotLokal) => {
    if (dataBotLokal.isBanned) return;
    try {
        dataBotLokal.sedangMengetik = true;
        const teksSpintax = spintax(teksMentah);
        const pecahan = teksSpintax.match(/[^.,?]+[.,?]*\s*/g) || [teksSpintax];
        for (let i = 0; i < pecahan.length; i++) {
            if (dataBotLokal.isBanned) break;
            let chunk = pecahan[i].trim();
            if (!chunk) continue;
            let teksKirim = injeksiNoise(buatTypo(chunk, 0.03));
            const durasiTotal = Math.max(1500, Math.floor((teksKirim.length / 5) * 1000));
            await sockLokal.sendPresenceUpdate('composing', jidLokal);
            await jedaWaktu(durasiTotal, durasiTotal + 800);
            await sockLokal.sendPresenceUpdate('paused', jidLokal);
            const buatTypoParah = Math.random() < 0.05 && teksKirim.length > 5;
            let teksAsli = chunk;
            if (buatTypoParah) {
                teksKirim = injeksiNoise(buatTypo(chunk, 0.3));
            }
            await sockLokal.sendMessage(jidLokal, { text: teksKirim });
            if (buatTypoParah) {
                await jedaWaktu(1000, 1500);
                await sockLokal.sendPresenceUpdate('composing', jidLokal);
                await jedaWaktu(1000, 2000);
                await sockLokal.sendPresenceUpdate('paused', jidLokal);
                const kataKata = teksAsli.split(' ');
                const kataTerakhir = kataKata[kataKata.length - 1].replace(/[.,?]/g, '');
                await sockLokal.sendMessage(jidLokal, { text: "*" + kataTerakhir });
            }
            if (i < pecahan.length - 1) {
                await jedaWaktu(1500, 3000);
            }
        }
        await jedaWaktu(1000, 2000);
        await sockLokal.sendPresenceUpdate('unavailable', jidLokal);
    } catch (e) {
        logMinimal('error', e.stack);
    } finally {
        dataBotLokal.sedangMengetik = false;
    }
};
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
    await jedaWaktu(2000, 3000);
    logMinimal('sistem', 'menidurkan soket untuk rotasi graceful');
    for (let bot of listBot) {
        if (bot.sock && !bot.isBanned) {
            try {
                bot.sock.ws.close();
            } catch (e) {
                logMinimal('error', e.stack);
            }
        }
    }
    await jedaWaktu(1000, 2000);
    logMinimal('sistem', 'menjalankan rotasi ip');
    try {
        execSync("su -c 'settings put global airplane_mode_on 1 && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true'");
        await jedaWaktu(3000, 5000);
        execSync("su -c 'settings put global airplane_mode_on 0 && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false'");
        let internetReady = false;
        let batasPing = 0;
        while (!internetReady && batasPing < 15) {
            try {
                execSync("ping -c 1 -W 2 8.8.8.8", { stdio: 'ignore' });
                internetReady = true;
            } catch (e) {
                batasPing++;
                await jedaWaktu(3000, 3000);
            }
        }
        if (!internetReady) {
            throw new Error("koneksi internet mati total setelah rotasi ip");
        }
        logMinimal('sistem', 'internet ready, menstabilkan jam sistem...');
        await jedaWaktu(2000, 3000); 
        logMinimal('sistem', 'rotasi ip berhasil, semua bot diizinkan reconnect paralel');
    } catch (e) {
        logMinimal('error', e.stack);
    } finally {
        sedangRotasi = false;
    }
};
function mulaiBot(dataBot) {
    return new Promise((resolve) => {
        const jalankanSocket = async () => {
            if (sedangShutdown || dataBot.isBanned) return;
            while (sedangRotasi) {
                await jedaWaktu(2000, 5000);
            }
            const namaFolderSesi = `sesi_${dataBot.nomor}`;
            let timerPairing = null;
            const msgRetryCounterCache = new NodeCache();
            let sock;
            try {
                const { state, saveCreds } = await useMultiFileAuthState(namaFolderSesi);
                const { version } = await fetchLatestBaileysVersion();
                const loggerSilent = pino({ level: 'silent' });
                if (!memStore[dataBot.nomor]) {
                    memStore[dataBot.nomor] = { messages: new Map() };
                }
                sock = makeWASocket({ 
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
                    syncFullHistory: false,
                    getMessage: async (key) => {
                        const botStore = memStore[dataBot.nomor];
                        if (botStore && botStore.messages.has(key.id)) {
                            return botStore.messages.get(key.id);
                        }
                        return undefined;
                    }
                });
                dataBot.sock = sock;
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
                                sock.ev.removeAllListeners();
                                sock.ws.close();
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
                        logMinimal('sistem', `mengamankan sinkronisasi ${dataBot.nama}...`);
                        await jedaWaktu(3000, 5000);
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
                        const isDariPartner = isPusatMenerima || isTargetMenerima;
                        if (duelAktif.status === 'berjalan' && isDariPartner) {
                            const giliranKu = (isPusatMenerima && duelAktif.pemegangTongkat === 'pusat') || (isTargetMenerima && duelAktif.pemegangTongkat === 'target');
                            if (giliranKu) {
                                const partnerBot = isPusatMenerima ? botTarget : botPusat;
                                while (partnerBot.sedangMengetik) {
                                    await jedaWaktu(1000, 1500);
                                }
                                if (dataBot.sedangMengetik) continue;
                                dataBot.sedangMengetik = true;
                                try {
                                    await sock.readMessages([msg.key]);
                                    await jedaWaktu(1500, 3000);
                                    if (isPusatMenerima) {
                                        if (duelAktif.topikAktif === 'sapaan') {
                                            const indexAcak = Math.floor(Math.random() * duelAktif.topikTersedia.length);
                                            duelAktif.topikAktif = duelAktif.topikTersedia.splice(indexAcak, 1)[0];
                                            duelAktif.jumlahTopik++;
                                            logMinimal(botPusat.nama, `mengirim topik acak: ${duelAktif.topikAktif}`);
                                            const teksKirim = databaseObrolan[duelAktif.topikAktif].tanya;
                                            duelAktif.pemegangTongkat = 'target';
                                            await kirimDinamis(sock, jid, teksKirim, dataBot);
                                        } else if (duelAktif.topikAktif === 'pamitan') {
                                            logMinimal(botPusat.nama, 'membaca pesan penutup');
                                            duelAktif.selesai = true;
                                            duelAktif.pemegangTongkat = null;
                                            dataBot.sedangMengetik = false;
                                        } else {
                                            if (duelAktif.jumlahTopik >= 3 || duelAktif.topikTersedia.length === 0) {
                                                duelAktif.topikAktif = 'pamitan';
                                            } else {
                                                const indexAcak = Math.floor(Math.random() * duelAktif.topikTersedia.length);
                                                duelAktif.topikAktif = duelAktif.topikTersedia.splice(indexAcak, 1)[0];
                                                duelAktif.jumlahTopik++;
                                            }
                                            logMinimal(botPusat.nama, `mengirim topik acak: ${duelAktif.topikAktif}`);
                                            const teksKirim = databaseObrolan[duelAktif.topikAktif].tanya;
                                            duelAktif.pemegangTongkat = 'target';
                                            await kirimDinamis(sock, jid, teksKirim, dataBot);
                                        }
                                    } else if (isTargetMenerima) {
                                        logMinimal(botTarget.nama, `membalas topik: ${duelAktif.topikAktif}`);
                                        const teksKirim = databaseObrolan[duelAktif.topikAktif].jawab;
                                        duelAktif.pemegangTongkat = 'pusat';
                                        await kirimDinamis(sock, jid, teksKirim, dataBot);
                                    }
                                } catch (e) {
                                    dataBot.sedangMengetik = false;
                                    logMinimal('error', e.stack);
                                }
                            } else {
                                try {
                                    await sock.readMessages([msg.key]);
                                } catch (e) {
                                    logMinimal('error', e.stack);
                                }
                            }
                        } else {
                            const isDariBotSirkel = listBot.some(b => b.nomor === pengirim);
                            if (isDariBotSirkel) {
                                try {
                                    await jedaWaktu(1500, 2500);
                                    await sock.readMessages([msg.key]);
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
                    while ((!pusat.isReady || !target.isReady) && batasTunggu < 120) {
                        if (pusat.isBanned || target.isBanned) break;
                        await jedaWaktu(2000, 2000);
                        batasTunggu++;
                    }
                    if (pusat.isBanned || target.isBanned || !pusat.isReady || !target.isReady) continue;
                    await jedaWaktu(1000, 2500);
                    duelAktif = { pusat: pertarungan.pusat, target: pertarungan.target, status: 'berjalan', selesai: false, pemegangTongkat: 'pusat', topikTersedia: ['domisili', 'umur', 'kesibukan', 'hobi', 'game', 'cuaca'], topikAktif: 'sapaan', jumlahTopik: 0 };
                    try {
                        logMinimal('duel', `${pusat.nama} vs ${target.nama} dimulai`);
                        const teksMentahAwal = databaseObrolan['sapaan'].tanya.replace('{namapusat}', pusat.nama);
                        const jidAwal = target.nomor + "@s.whatsapp.net";
                        pusat.sedangMengetik = true;
                        duelAktif.pemegangTongkat = 'target';
                        await kirimDinamis(pusat.sock, jidAwal, teksMentahAwal, pusat);
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
                    logMinimal('duel', 'selesai (status: acak)');
                    duelAktif.status = 'idle';
                    const jeda = Math.floor(Math.random() * (4000 - 2000 + 1)) + 2000;
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
