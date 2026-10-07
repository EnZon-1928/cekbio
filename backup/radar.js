const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const pino = require('pino');
const fs = require('fs');
const { execSync } = require('child_process');
const xlsx = require('xlsx');
const readline = require('readline');

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

const jedaWaktu = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

const denganBatasWaktu = (promise, waktuBatas) => {
    let pengaturWaktu;
    const batasPromise = new Promise((_, reject) => {
        pengaturWaktu = setTimeout(() => {
            reject(new Error("waktu tunggu eksekusi habis"));
        }, waktuBatas);
    });
    return Promise.race([promise, batasPromise]).finally(() => clearTimeout(pengaturWaktu));
};

const pecahGelombang = (array, ukuran) => {
    const hasil = [];
    for (let i = 0; i < array.length; i += ukuran) {
        hasil.push(array.slice(i, i + ukuran));
    }
    return hasil;
};

// ================= GLOBAL STATE =================
let mesinBerjalan = false;
let sesiAktif = 1;

try {
    const folderAda = fs.readdirSync('.').filter(f => f.startsWith('sesi_radar_'));
    if (folderAda.length > 0) {
        const angkaSesi = folderAda.map(f => parseInt(f.replace('sesi_radar_', ''))).filter(n => !isNaN(n));
        if (angkaSesi.length > 0) sesiAktif = Math.max(...angkaSesi);
    }
} catch (e) {
    logMinimal('error', 'gagal melacak riwayat folder sesi: ' + e.stack);
}

let gelombangIndex = 0;
let gelombang = [];

let targetPersonal = [];
let targetBisnis = [];
let targetBodong = []; // pipa baru buat amnesia bodong

let logPersonal = [];
let logBisnis = [];
let logBodong = [];

let statistik = { terdaftar: 0, bodong: 0, bioWa: 0, bioBisnis: 0, tanpaBioWa: 0, tanpaBioBisnis: 0 };
let minJeda = 10000;
let maxJeda = 20000;
let totalAwalPeluru = 0;

const simpanLaporanAman = () => {
    try {
        const waktuSelesai = new Date().toLocaleString('id-ID');

        // pipa personal
        fs.writeFileSync('target_personal.json', JSON.stringify(targetPersonal, null, 4));
        let isiPersonal = `╔═══════════════════════════════╗\n║ RADAR REPORT - WA PERSONAL    ║\n╚═══════════════════════════════╝\n`;
        isiPersonal += `∟ 📅 tanggal       : ${waktuSelesai}\n`;
        isiPersonal += `∟ 🔢 total leads   : ${targetPersonal.length}\n\n`;
        isiPersonal += `───────── 📊 RINGKASAN ─────────\n`;
        isiPersonal += `∟ 📝 ada bio       : ${statistik.bioWa}\n`;
        isiPersonal += `∟ 📵 tanpa bio     : ${statistik.tanpaBioWa}\n\n`;
        isiPersonal += `────────── 📝 DATA NOMOR ──────────\n`;
        isiPersonal += logPersonal.length > 0 ? logPersonal.join('\n\n') : `   (kosong)\n`;
        fs.writeFileSync('report_personal.txt', isiPersonal);

        // pipa bisnis elit
        fs.writeFileSync('target_bisnis.json', JSON.stringify(targetBisnis, null, 4));
        let isiBisnis = `╔═══════════════════════════════╗\n║ RADAR REPORT - WA BISNIS      ║\n╚═══════════════════════════════╝\n`;
        isiBisnis += `∟ 📅 tanggal       : ${waktuSelesai}\n`;
        isiBisnis += `∟ 🔢 total leads   : ${targetBisnis.length}\n\n`;
        isiBisnis += `───────── 📊 RINGKASAN ─────────\n`;
        isiBisnis += `∟ 📝 ada bio/desc  : ${statistik.bioBisnis}\n`;
        isiBisnis += `∟ 📵 tanpa desc    : ${statistik.tanpaBioBisnis}\n\n`;
        isiBisnis += `────────── 📝 DATA NOMOR ──────────\n`;
        isiBisnis += logBisnis.length > 0 ? logBisnis.join('\n\n') : `   (kosong)\n`;
        fs.writeFileSync('report_bisnis.txt', isiBisnis);

        // pipa target bodong/mati (kuburan terpisah mutlak)
        fs.writeFileSync('target_bodong.json', JSON.stringify(targetBodong, null, 4));
        let isiBodong = `╔═══════════════════════════════╗\n║ RADAR REPORT - WA BODONG/MATI ║\n╚═══════════════════════════════╝\n`;
        isiBodong += `∟ 📅 tanggal       : ${waktuSelesai}\n`;
        isiBodong += `∟ 🔢 total bodong  : ${targetBodong.length}\n\n`;
        isiBodong += `──── 🚫 TIDAK TERDAFTAR WA ─────\n`;
        isiBodong += logBodong.length > 0 ? logBodong.join('\n') : `   (kosong)\n`;
        fs.writeFileSync('report_bodong.txt', isiBodong);

    } catch (e) {
        logMinimal('error', 'gagal simpan auto-save isolasi: ' + e.stack);
    }
};
// ================================================

async function mulaiRadar() {
    try {
        const folderSesi = `sesi_radar_${sesiAktif}`;
        const { state, saveCreds } = await useMultiFileAuthState(folderSesi);
        const { version } = await fetchLatestBaileysVersion();
        const loggerSilent = pino({ level: 'silent' });
        const msgRetryCounterCache = new NodeCache();
        
        const sock = makeWASocket({
            version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, loggerSilent) },
            msgRetryCounterCache,
            printQRInTerminal: false,
            logger: loggerSilent,
            browser: ["Ubuntu", "Chrome", "119.0.6045.105"]
        });

        if (!sock.authState.creds.registered) {
            const rlTemp = readline.createInterface({ input: process.stdin, output: process.stdout });
            const tanyaTemp = (pertanyaan) => new Promise(resolve => rlTemp.question(pertanyaan, resolve));
            const noWa = await tanyaTemp(`[+] masukkan nomor tumbal untuk sesi_${sesiAktif} (contoh: 628xxx): `);
            rlTemp.close();
            try {
                const kode = await sock.requestPairingCode(noWa.replace(/[^0-9]/g, ''));
                let kodeFormat = kode?.match(/.{1,4}/g)?.join("-") || kode;
                console.log(`\n========================================`);
                console.log(`[kode pairing sesi_${sesiAktif}]: ${kodeFormat}`);
                console.log(`========================================\n`);
            } catch (e) {
                logMinimal('error', e.stack);
            }
        }

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                mesinBerjalan = false;
                const alasan = lastDisconnect?.error?.output?.statusCode;
                
                if (alasan === 403 || alasan === DisconnectReason.loggedOut || alasan === 401) {
                    logMinimal('fatal', `akun tumbal sesi_${sesiAktif} tewas terbanned meta / logout.`);
                    
                    try { if (sock.ws) sock.ws.close(); } catch (e) { logMinimal('error', 'gagal mematikan socket: ' + e.stack); }
                    try { fs.rmSync(folderSesi, { recursive: true, force: true }); } catch (e) { logMinimal('error', e.stack); }
                    
                    sesiAktif++;
                    if (sesiAktif > 10) {
                        logMinimal('fatal', 'batas mutlak 10 sesi telah habis terblokir. operasi dihentikan.');
                        process.exit(1);
                    } else {
                        logMinimal('sistem', `estafet nyala. mutasi operasi ke sesi_${sesiAktif}...`);
                        setTimeout(() => mulaiRadar(), 3000);
                    }
                } else {
                    setTimeout(() => mulaiRadar(), 5000);
                }
            } else if (connection === 'open') {
                if (mesinBerjalan) return;
                mesinBerjalan = true;
                logMinimal('sistem', `mesin radar siluman aktif (sesi_${sesiAktif}). mengeksekusi batching paralel...`);
                await jedaWaktu(3000, 5000);

                try {
                    for (; gelombangIndex < gelombang.length; gelombangIndex++) {
                        const peluruGelombang = gelombang[gelombangIndex];
                        logMinimal('sistem', `menembak gelombang ${gelombangIndex + 1}/${gelombang.length} (${peluruGelombang.length} nomor)...`);

                        try {
                            const jidGelombang = peluruGelombang.map(n => `${n}@s.whatsapp.net`);
                            const hasilWa = await denganBatasWaktu(sock.onWhatsApp(...jidGelombang), 15000);

                            if (hasilWa && hasilWa.length > 0) {
                                const targetValid = hasilWa.filter(r => r.exists);
                                const targetBodong = hasilWa.filter(r => !r.exists);

                                targetBodong.forEach(r => {
                                    statistik.bodong++;
                                    const nomorBodong = r.jid.split('@')[0];
                                    const nomorPlus = '+' + nomorBodong; // suntikan +
                                    logMinimal('miss', `[${nomorPlus}] => bodong`);
                                    logBodong.push(`   • ${nomorPlus}`);
                                    targetBodong.push({ nomor: nomorPlus });
                                });

                                const janjiParalel = targetValid.map(async (res) => {
                                    const nomorTarget = res.jid.split('@')[0];
                                    const nomorPlus = '+' + nomorTarget; // suntikan +
                                    let statusTarget = "";
                                    let waktuBio = "";
                                    let tipeAkun = "personal";
                                    
                                    let infoBisnis = "(kosong)";
                                    let descBisnis = "";
                                    let website = "";
                                    let email = "";
                                    let dataKatalog = "(kosong)";
                                    
                                    let amanCekBisnis = true;

                                    try {
                                        const statusRes = await denganBatasWaktu(sock.fetchStatus(res.jid), 5000);
                                        if (statusRes && statusRes.status) {
                                            statusTarget = statusRes.status;
                                            if (statusRes.setAt) {
                                                const tgl = new Date(statusRes.setAt);
                                                const h = String(tgl.getDate()).padStart(2, '0');
                                                const m = String(tgl.getMonth() + 1).padStart(2, '0');
                                                const y = tgl.getFullYear();
                                                waktuBio = `${h}/${m}/${y}`;
                                            }
                                        }
                                    } catch (e) {
                                        if (e.message && e.message.includes('waktu tunggu')) amanCekBisnis = false;
                                        logMinimal('error', 'timeout fetch bio: ' + e.stack);
                                    }

                                    if (amanCekBisnis) {
                                        try {
                                            const bizRes = await denganBatasWaktu(sock.getBusinessProfile(res.jid), 4000);
                                            if (bizRes) {
                                                tipeAkun = "business";
                                                const kategori = bizRes.category || "unknown";
                                                const tier = bizRes.tier ? bizRes.tier.toLowerCase() : "smb";
                                                let statusVerifikasi = "[business reguler]";
                                                if (tier === "high" || tier === "verified") statusVerifikasi = "[official/verified]";
                                                infoBisnis = `${statusVerifikasi} | ${kategori}`;
                                                if (bizRes.description) descBisnis = bizRes.description;
                                                
                                                if (bizRes.website) website = Array.isArray(bizRes.website) ? bizRes.website.join(', ') : bizRes.website;
                                                if (bizRes.email) email = bizRes.email;
                                            }
                                        } catch (e) {
                                            logMinimal('error', 'timeout fetch bisnis: ' + e.stack);
                                        }
                                    }

                                    if (tipeAkun === "business") {
                                        try {
                                            const catRes = await denganBatasWaktu(sock.getCatalog(res.jid), 4000);
                                            if (catRes && catRes.products && catRes.products.length > 0) {
                                                const totalProduk = catRes.products.length;
                                                const produkContoh = catRes.products.slice(0, 2).map(p => p.name).join(' | ');
                                                dataKatalog = `${totalProduk} item [ex: ${produkContoh}]`;
                                            }
                                        } catch (e) {
                                            // aman
                                        }
                                    }

                                    let bioFinal = descBisnis || statusTarget || "(kosong)";
                                    return { nomorTarget, nomorPlus, tipeAkun, infoBisnis, bioFinal, waktuBio, website, email, dataKatalog };
                                });

                                const hasilParalel = await Promise.all(janjiParalel);

                                hasilParalel.forEach(data => {
                                    statistik.terdaftar++;
                                    let formatBio = data.bioFinal !== "(kosong)" ? data.bioFinal.replace(/\n/g, '\n     │             ') : data.bioFinal;
                                    let logData = `   • ${data.nomorPlus}\n     ├─ tipe     : ${data.tipeAkun}\n`;

                                    if (data.tipeAkun === "business") {
                                        if (data.bioFinal !== "(kosong)") statistik.bioBisnis++; else statistik.tanpaBioBisnis++;
                                        
                                        logData += `     ├─ kategori : ${data.infoBisnis}\n`;
                                        if (data.website) logData += `     ├─ website  : ${data.website}\n`;
                                        if (data.email) logData += `     ├─ email    : ${data.email}\n`;
                                        logData += `     ├─ katalog  : ${data.dataKatalog}\n`;
                                        logData += `     ├─ update   : ${data.waktuBio || 'unknown'}\n     └─ bio/desc : ${formatBio}`;
                                        
                                        logBisnis.push(logData);
                                        targetBisnis.push({
                                            nomor: data.nomorPlus,
                                            kategori: data.infoBisnis,
                                            website: data.website || null,
                                            email: data.email || null,
                                            katalog: data.dataKatalog !== "(kosong)" ? data.dataKatalog : null,
                                            bio: data.bioFinal,
                                            updateTerakhir: data.waktuBio
                                        });
                                        
                                    } else {
                                        if (data.bioFinal !== "(kosong)") statistik.bioWa++; else statistik.tanpaBioWa++;
                                        
                                        logData += `     ├─ update   : ${data.waktuBio || 'unknown'}\n     └─ bio/desc : ${formatBio}`;
                                        
                                        logPersonal.push(logData);
                                        targetPersonal.push({
                                            nomor: data.nomorPlus,
                                            bio: data.bioFinal,
                                            updateTerakhir: data.waktuBio
                                        });
                                    }
                                    
                                    logMinimal('hit', `[${data.nomorPlus}] => ${data.tipeAkun} | bio: ${data.bioFinal !== "(kosong)" ? "ada" : "kosong"}`);
                                });
                            }
                        } catch (e) {
                            logMinimal('error', 'gelombang terputus: ' + e.stack);
                            throw e; 
                        }

                        simpanLaporanAman();

                        if (gelombangIndex < gelombang.length - 1) {
                            const jedaGelombang = Math.floor(Math.random() * (maxJeda - minJeda + 1)) + minJeda;
                            logMinimal('sistem', `gelombang paralel selesai. mesin tidur selama ${jedaGelombang / 1000} detik...`);
                            await jedaWaktu(jedaGelombang, jedaGelombang);
                        }
                    }

                    const totalBio = statistik.bioWa + statistik.bioBisnis;
                    logMinimal('selesai', `[report] personal: ${targetPersonal.length} | bisnis elit: ${targetBisnis.length} | bodong: ${targetBodong.length}`);
                    logMinimal('sistem', 'data matang disimpan ganda. operasi tuntas.');
                    process.exit(0);

                } catch (e) {
                    logMinimal('error', e.stack);
                    mesinBerjalan = false;
                }
            }
        });
    } catch (e) {
        logMinimal('error', e.stack);
    }
}

async function inisialisasiPusat() {
    try {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const tanyaTerminal = (pertanyaan) => new Promise(resolve => rl.question(pertanyaan, resolve));

        // fitur interogasi reset cache
        if (fs.existsSync('target_personal.json') || fs.existsSync('target_bisnis.json') || fs.existsSync('target_bodong.json')) {
            console.log('\n[!] peringatan: sisa riwayat target kemaren terdeteksi.');
            const jawab = await tanyaTerminal('[?] mau lanjut (y) atau hapus total dan mulai dari nol (n)? (y/n): ');
            if (jawab.trim().toLowerCase() === 'n') {
                logMinimal('sistem', 'membumihanguskan semua jasad file kemaren...');
                const filesToDel = ['target_personal.json', 'target_bisnis.json', 'target_bodong.json', 'report_personal.txt', 'report_bisnis.txt', 'report_bodong.txt'];
                filesToDel.forEach(f => {
                    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { logMinimal('error', 'gagal hapus file: ' + e.stack); }
                });
            }
        }
        
        console.log('\n╔════════════════════════════════════╗');
        console.log('║  RADAR TARGET (PARALEL & ELITE)    ║');
        console.log('╚════════════════════════════════════╝');
        console.log('1. file xlsx (mentahan.xlsx)');
        console.log('2. file txt (mentahan.txt)');
        console.log('3. paste manual (paste langsung di layar)');
        const pilihAmunisi = await tanyaTerminal('pilih sumber amunisi (1/2/3): ');

        let hasilMatch = [];

        if (pilihAmunisi === '1') {
            if (fs.existsSync('mentahan.xlsx')) {
                logMinimal('sistem', 'membaca mentahan dengan logic raw anti-scientific...');
                const workbook = xlsx.readFile('mentahan.xlsx');
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true });
                
                for (let baris of data) {
                    for (let sel of baris) {
                        if (sel !== null && sel !== undefined) {
                            let val = (typeof sel === 'number') ? sel.toLocaleString('fullwide', {useGrouping:false}) : String(sel);
                            let nomor = val.replace(/\D/g, '');
                            if (nomor.length >= 10 && nomor.length <= 15) hasilMatch.push(nomor);
                        }
                    }
                }
            } else { logMinimal('fatal', 'mentahan.xlsx tidak ditemukan!'); process.exit(1); }
        } else if (pilihAmunisi === '2') {
            if (fs.existsSync('mentahan.txt')) {
                logMinimal('sistem', 'membaca dari mentahan.txt...');
                const isiTxt = fs.readFileSync('mentahan.txt', 'utf8');
                const kataKasar = isiTxt.split(/[\n,;|\t\s]+/);
                for (let kata of kataKasar) {
                    let angkaMurni = kata.replace(/\D/g, '');
                    if (angkaMurni.length >= 10 && angkaMurni.length <= 15) hasilMatch.push(angkaMurni);
                }
            } else { logMinimal('fatal', 'mentahan.txt tidak ditemukan!'); process.exit(1); }
        } else if (pilihAmunisi === '3') {
            console.log('\npaste deretan nomor di sini (bisa banyak baris berderet ke bawah).');
            console.log('jika sudah di-paste semua, ketik kata "gas" di baris baru lalu tekan enter:');
            
            const pasteManual = await new Promise(resolve => {
                let kumpul = "";
                const tangkapBaris = (baris) => {
                    if (baris.trim().toLowerCase() === 'gas') {
                        rl.removeListener('line', tangkapBaris);
                        resolve(kumpul);
                    } else {
                        kumpul += baris + "\n";
                    }
                };
                rl.on('line', tangkapBaris);
            });
            
            const kataKasar = pasteManual.split(/[\n,;|\t\s]+/);
            for (let kata of kataKasar) {
                let angkaMurni = kata.replace(/\D/g, '');
                if (angkaMurni.length >= 10 && angkaMurni.length <= 15) hasilMatch.push(angkaMurni);
            }
        } else {
            logMinimal('fatal', 'input amunisi salah.'); process.exit(1);
        }

        const daftarNomor = [...new Set(hasilMatch)];

        console.log('\n=== setelan kecepatan transmisi ===');
        console.log('1. gigi santai (20-30 detik)');
        console.log('2. gigi normal (10-20 detik)');
        console.log('3. gigi brutal (0,5-0,6 detik) -> rentan banned!');
        const pilihGigi = await tanyaTerminal('pilih rasio kecepatan (1/2/3): ');
        
        if (pilihGigi === '1') { minJeda = 20000; maxJeda = 30000; }
        else if (pilihGigi === '2') { minJeda = 10000; maxJeda = 20000; }
        else if (pilihGigi === '3') { minJeda = 500; maxJeda = 600; }
        else { logMinimal('sistem', 'input salah, pakai gigi normal.'); minJeda = 10000; maxJeda = 20000; }

        rl.close();

        // sinkronisasi visual dan proteksi anti ngulang dengan filter stealth
        let nomorSudahDicek = [];
        if (fs.existsSync('target_personal.json')) {
            try {
                const cacheP = JSON.parse(fs.readFileSync('target_personal.json', 'utf8'));
                targetPersonal = cacheP;
                cacheP.forEach(item => {
                    nomorSudahDicek.push(item.nomor.replace(/\D/g, '')); // filter anti-ngulang murni angka
                    let formatBio = item.bio !== "(kosong)" ? item.bio.replace(/\n/g, '\n     │             ') : item.bio;
                    let logData = `   • ${item.nomor}\n     ├─ tipe     : personal\n     ├─ update   : ${item.updateTerakhir || 'unknown'}\n     └─ bio/desc : ${formatBio}`;
                    logPersonal.push(logData); // rakit memori txt visual
                });
                statistik.terdaftar += cacheP.length;
            } catch(e) { logMinimal('error', 'gagal baca cache personal: ' + e.stack); }
        }
        
        if (fs.existsSync('target_bisnis.json')) {
            try {
                const cacheB = JSON.parse(fs.readFileSync('target_bisnis.json', 'utf8'));
                targetBisnis = cacheB;
                cacheB.forEach(item => {
                    nomorSudahDicek.push(item.nomor.replace(/\D/g, ''));
                    let formatBio = item.bio !== "(kosong)" ? item.bio.replace(/\n/g, '\n     │             ') : item.bio;
                    let logData = `   • ${item.nomor}\n     ├─ tipe     : business\n     ├─ kategori : ${item.kategori}\n`;
                    if (item.website) logData += `     ├─ website  : ${item.website}\n`;
                    if (item.email) logData += `     ├─ email    : ${item.email}\n`;
                    if (item.katalog) logData += `     ├─ katalog  : ${item.katalog}\n`;
                    logData += `     ├─ update   : ${item.updateTerakhir || 'unknown'}\n     └─ bio/desc : ${formatBio}`;
                    logBisnis.push(logData); // rakit memori txt visual
                });
                statistik.terdaftar += cacheB.length;
            } catch(e) { logMinimal('error', 'gagal baca cache bisnis: ' + e.stack); }
        }

        if (fs.existsSync('target_bodong.json')) {
            try {
                const cacheBod = JSON.parse(fs.readFileSync('target_bodong.json', 'utf8'));
                targetBodong = cacheBod;
                cacheBod.forEach(item => {
                    nomorSudahDicek.push(item.nomor.replace(/\D/g, ''));
                    logBodong.push(`   • ${item.nomor}`); // rakit memori txt visual
                });
                statistik.bodong += cacheBod.length;
            } catch(e) { logMinimal('error', 'gagal baca cache bodong: ' + e.stack); }
        }

        const peluruBaru = daftarNomor.filter(n => !nomorSudahDicek.includes(n));
        totalAwalPeluru = daftarNomor.length;

        if (peluruBaru.length === 0) {
            logMinimal('fatal', '0 peluru baru ditemukan. pastikan data valid atau belum pernah dieksekusi.');
            process.exit(0);
        }

        logMinimal('database', `${peluruBaru.length} peluru baru dimuat. mengeksekusi estafet (sesi max: ${sesiAktif})...`);
        gelombang = pecahGelombang(peluruBaru, 20); 
        
        mulaiRadar();

    } catch (e) {
        logMinimal('error', 'inisialisasi gagal: ' + e.stack);
        process.exit(1);
    }
}

inisialisasiPusat();
