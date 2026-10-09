require('dotenv').config();
const { Bot } = require('grammy');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('Set TELEGRAM_BOT_TOKEN in .env first.');
    process.exitCode = 1;
} else {
    const bot = new Bot(token);
    bot.on('message:text', async (ctx, next) => {
        if (ctx.chat?.type !== 'private' || ctx.chat.id !== ctx.from?.id) return;
        if (ctx.message.text.trim() === '/myid') {
            await ctx.reply(`Your Telegram user ID: ${ctx.from.id}`);
            return;
        }
        await next();
    });
    bot.catch(() => console.error('Could not process the ID request.'));

    process.once('SIGINT', () => bot.stop());
    process.once('SIGTERM', () => bot.stop());

    bot.init().then(() => bot.api.setMyCommands([
        { command: 'myid', description: 'Show your numeric user ID' }
    ])).then(() => {
        console.log('Send /myid to your bot in a private chat. Press Ctrl+C when done.');
        return bot.start();
    }).catch(() => {
        console.error('Telegram ID helper failed. Check the token and internet connection.');
        process.exitCode = 1;
    });
}
