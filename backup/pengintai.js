const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const nomor = process.argv[2];

async function jalankanPengintai() {
    try {
        if (!nomor) {
            console.log('eksekusi ditolak: wajib masukkan nomor target pengintaian.');
            process.exit(1);
        }

        const { state, saveCreds } = await useMultiFileAuthState(`sesi_pengintai_${nomor}`);
        
        const fileLogger = pino({ level: 'trace' }, pino.destination(`./log_pembantaian_${nomor}.txt`));

        const isRegistered = !!state.creds.registered;

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            browser: ['ubuntu', 'chrome', '120.0.0'],
            logger: fileLogger
        });

        if (!isRegistered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(nomor);
                    console.log(`kode pairing pengintai untuk ${nomor}: ${code}`);
                } catch (e) {
                    console.error(e.stack);
                }
            }, 3000);
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            try {
                const { connection, lastDisconnect } = update;
                if (connection === 'close') {
                    const status = lastDisconnect?.error?.output?.statusCode;
                    console.log(`koneksi putus! kode: ${status}`);

                    if (status === 515) {
                        console.log(`[info] restart wajib paska-pairing. menyambung ulang...`);
                        jalankanPengintai();
                    } else if (status === 429 || status === 403 || status === 401) {
                        console.log(`[eksekusi meta] mesin dibantai! status: ${status}`);
                        console.log(`segera periksa file log_pembantaian_${nomor}.txt`);
                        process.exit(1);
                    } else if (status !== DisconnectReason.loggedOut) {
                        console.log(`[info] putus jaringan biasa, menyambung ulang...`);
                        setTimeout(() => jalankanPengintai(), 5000);
                    } else {
                        console.log(`[info] perangkat dikeluarkan.`);
                        process.exit(1);
                    }
                } else if (connection === 'open') {
                    console.log(`mesin pengintai mutlak terhubung untuk nomor ${nomor}.`);
                }
            } catch (e) {
                console.error(e.stack);
            }
        });
    } catch (e) {
        console.error(e.stack);
    }
}

jalankanPengintai();
