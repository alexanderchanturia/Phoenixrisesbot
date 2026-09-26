require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = process.env.WEBAPP_URL;

bot.start((ctx) => {
  ctx.reply(
    'The Phoenix Rises 🔥\n\nTap. Earn. Rebuild the flame from ash.',
    Markup.inlineKeyboard([
      Markup.button.webApp('Enter the Flame', WEBAPP_URL)
    ])
  );
});

bot.command('play', (ctx) => {
  ctx.reply(
    'Back to the flame.',
    Markup.inlineKeyboard([Markup.button.webApp('Open Phoenix Rises', WEBAPP_URL)])
  );
});

bot.launch();
console.log('Phoenix Rises bot is running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
